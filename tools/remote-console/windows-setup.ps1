param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(1, 2, 3)]
    [int]$Step,
    [switch]$Elevated,
    [int]$ConsolePort = 0,
    [string]$ResultFile
)

$ErrorActionPreference = 'Stop'
$port = 8790
if ($env:WHALE_CONSOLE_PORT) { $port = [int]$env:WHALE_CONSOLE_PORT }
if ($ConsolePort) { $port = $ConsolePort }
if ($port -lt 1 -or $port -gt 65535) { throw '无效的控制台端口。' }

$consoleUrl = "http://127.0.0.1:$port"
$consoleFolder = $PSScriptRoot
$privateDir = Join-Path $env:LOCALAPPDATA 'WhaleGirlRemoteConsole'
$keyFile = Join-Path $privateDir "saved-pairing-$port.xml"
$legacyKeyFile = Join-Path $privateDir "pairing-$port.xml"
$tailscaleDir = Join-Path $env:ProgramFiles 'Tailscale'
$tailscaleGui = Join-Path $tailscaleDir 'tailscale-ipn.exe'
$tailscaleCli = Join-Path $tailscaleDir 'tailscale.exe'

function Read-SavedPairingKey {
    $path = if (Test-Path -LiteralPath $keyFile) { $keyFile } else { $legacyKeyFile }
    if (-not (Test-Path -LiteralPath $path)) { return }
    try {
        $encrypted = Import-Clixml -LiteralPath $path
        if ($encrypted -isnot [System.Security.SecureString]) { return }
        $key = [System.Net.NetworkCredential]::new('', $encrypted).Password
        if ($key -cmatch '^[a-f0-9]{48}$') { return $key }
    } catch { return }
}

function Read-RunningPairingKey([int]$WaitSeconds = 8) {
    $key = Read-SavedPairingKey
    if (-not $key) { throw '当前 Windows 用户的配对信息不可用。请用同一个 Windows 账号打开第 2 步和第 3 步。' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $folder = [IO.Path]::GetFullPath($consoleFolder).TrimEnd('\').ToUpperInvariant()
        $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($folder))).Replace('-', '')
    } finally { $sha.Dispose() }

    $wait = [Diagnostics.Stopwatch]::StartNew()
    do {
        # 只直连本机。系统代理或重定向不能接收配对 Key，也不能代答健康检查。
        $request = [Net.HttpWebRequest][Net.WebRequest]::Create("$consoleUrl/console/pairing")
        $request.Proxy = $null
        $request.AllowAutoRedirect = $false
        $request.Timeout = 1200
        $request.Method = 'HEAD'
        $request.Headers['Authorization'] = 'Bearer ' + $key
        $response = $null
        try {
            try { $response = $request.GetResponse() }
            catch [Net.WebException] {
                if ($_.Exception.Response) { $response = $_.Exception.Response }
                elseif ($_.Exception.Status -notin @('ConnectFailure', 'Timeout', 'ReceiveFailure', 'ConnectionClosed')) { throw }
            }
            if ($response) {
                $status = [int]$response.StatusCode
                if ($status -eq 204 -and $response.Headers['X-Whale-Console-Instance'] -eq $hash) { return $key }
                Write-PhoneAccessLog "Local console did not match (HTTP $status)."
                if ($status -eq 401) {
                    throw '本机端口上的控制台拒绝了当前配对 Key。请关闭旧的第 2 步窗口，再从这个文件夹启动第 2 步。'
                }
                throw "端口 $port 上运行的不是这个文件夹里的新版控制台。请关闭其他版本的第 2 步窗口，再打开本文件夹的第 2 步。"
            }
        } finally { if ($response) { $response.Dispose() } }
        if ($wait.Elapsed.TotalSeconds -lt $WaitSeconds) { Start-Sleep -Milliseconds 350 }
    } while ($wait.Elapsed.TotalSeconds -lt $WaitSeconds)
    Write-PhoneAccessLog "Local console did not respond on port $port."
    throw "本机端口 $port 没有收到控制台响应。请看第 2 步窗口是否已显示配对 Key 或启动错误，并保持窗口开启。"
}

function Get-OrCreatePairingKey {
    $key = Read-SavedPairingKey
    if ($key -and (Test-Path -LiteralPath $keyFile)) { return $key }
    if (-not $key) {
        $keyBytes = New-Object byte[] 24
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($keyBytes) } finally { $rng.Dispose() }
        $key = [System.BitConverter]::ToString($keyBytes).Replace('-', '').ToLowerInvariant()
    }
    New-Item -ItemType Directory -Path $privateDir -Force | Out-Null
    $tempKeyFile = "$keyFile.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        ConvertTo-SecureString -AsPlainText -Force $key | Export-Clixml -LiteralPath $tempKeyFile
        if (Test-Path -LiteralPath $keyFile) {
            [IO.File]::Replace($tempKeyFile, $keyFile, [NullString]::Value)
        } else {
            [IO.File]::Move($tempKeyFile, $keyFile)
        }
    } finally {
        Remove-Item -LiteralPath $tempKeyFile -ErrorAction SilentlyContinue
    }
    return $key
}

function Write-PhoneAccessLog([string]$Message) {
    try {
        New-Item -ItemType Directory -Path $privateDir -Force | Out-Null
        Add-Content -LiteralPath (Join-Path $privateDir 'phone-access.log') -Encoding UTF8 -Value (
            (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz') + ' ' + $Message)
    } catch {
        Write-Host '无法写入手机访问诊断日志。' -ForegroundColor Yellow
    }
}

function Get-PhoneAccessAddress {
    if (-not (Test-Path -LiteralPath $tailscaleCli)) { throw '请先完成第 1 步，安装并登录 Tailscale。' }
    $principal = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        if ($Elevated) { throw 'Tailscale Serve 需要 Windows 管理员权限。' }
        Write-Host '如果 Windows 弹出权限确认，请允许配置 Tailscale Serve。'
        $result = Join-Path ([IO.Path]::GetTempPath()) ('whale-phone-' + [guid]::NewGuid().ToString('N') + '.url')
        $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Step 3 -Elevated -ConsolePort ' + $port + ' -ResultFile "' + $result + '"'
        try {
            $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -ArgumentList $arguments -PassThru -Wait
            if ($process.ExitCode -ne 0) { throw "Tailscale 配置失败（代码 $($process.ExitCode)），未复制地址。" }
            if (-not (Test-Path -LiteralPath $result -PathType Leaf)) { throw '管理员窗口未返回手机地址。' }
            return [IO.File]::ReadAllText($result).Trim()
        } finally {
            Remove-Item -LiteralPath $result -ErrorAction SilentlyContinue
        }
    }
    Get-TailscaleServeAddress
}

function Read-TailscaleJson([string]$Arguments, [string]$Stage) {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $tailscaleCli
    $start.Arguments = $Arguments
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.Encoding]::UTF8
    $start.StandardErrorEncoding = [Text.Encoding]::UTF8

    $process = [System.Diagnostics.Process]::Start($start)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(10000)) {
            $process.Kill()
            throw "Tailscale $Stage 超时。"
        }
        if ($process.ExitCode -ne 0) {
            $errorText = $stderr.GetAwaiter().GetResult()
            if ($errorText) { Write-Host $errorText.Trim() -ForegroundColor Yellow }
            throw "Tailscale $Stage 失败（代码 $($process.ExitCode)）。"
        }
        $json = $stdout.GetAwaiter().GetResult().TrimStart([char]0xFEFF)
        try {
            $value = ConvertFrom-Json -InputObject $json -ErrorAction Stop
        } catch {
            Write-PhoneAccessLog "Tailscale $Stage returned unreadable JSON."
            throw "Tailscale $Stage 返回的状态无法读取。"
        }
        Write-PhoneAccessLog "Tailscale $Stage read successfully."
        return $value
    } finally { $process.Dispose() }
}

function Start-ConsoleServe([int]$ServePort) {
    Write-Host '正在启用手机访问。如果 Tailscale 要求首次授权，会打开浏览器。' -ForegroundColor Cyan
    Write-PhoneAccessLog 'Starting Tailscale Serve.'
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $tailscaleCli
    $start.Arguments = "serve --bg --yes --https=$ServePort $consoleUrl"
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.Encoding]::UTF8
    $start.StandardErrorEncoding = [Text.Encoding]::UTF8
    $process = [System.Diagnostics.Process]::Start($start)
    try {
        $streams = @($process.StandardOutput, $process.StandardError)
        $reads = @($streams[0].ReadLineAsync(), $streams[1].ReadLineAsync())
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $nextNotice = 20
        $opened = $false
        while ($reads[0] -or $reads[1] -or -not $process.HasExited) {
            foreach ($i in 0,1) {
                if (-not $reads[$i] -or -not $reads[$i].IsCompleted) { continue }
                $line = $reads[$i].GetAwaiter().GetResult()
                if ($null -eq $line) { $reads[$i] = $null; continue }
                $reads[$i] = $streams[$i].ReadLineAsync()
                Write-Host $line
                if (-not $opened -and $line -match '(https://(?:login|admin)\.tailscale\.com/[^\s<>"]+)') {
                    $authUrl = $Matches[1]
                    $opened = $true
                    Write-PhoneAccessLog 'Tailscale requested browser authorization.'
                    Write-Host '请在 Tailscale 网页确认启用 Serve，然后回到这个窗口。'
                    try { Start-Process -FilePath $authUrl -ErrorAction Stop }
                    catch { Write-Host '浏览器未能自动打开，请打开上面显示的 Tailscale 授权链接。' }
                }
            }
            if ($timer.Elapsed.TotalSeconds -ge 180) { throw '等待 Tailscale 超时。请完成网页授权后重试第 3 步。' }
            if ($timer.Elapsed.TotalSeconds -ge $nextNotice) {
                Write-Host '还在等待 Tailscale 回应……'
                $nextNotice += 20
            }
            [Threading.Thread]::Sleep(80)
        }
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw "Tailscale Serve 未启用（代码 $($process.ExitCode)），请查看上方提示。" }
    } finally {
        if (-not $process.HasExited) { $process.Kill() }
        $process.Dispose()
    }
}

function Get-TailscaleServeAddress {
    $status = Read-TailscaleJson 'status --json --peers=false' '设备状态'
    $dnsName = ([string]$status.Self.DNSName).TrimEnd('.')
    if ($status.BackendState -ne 'Running' -or $dnsName -notmatch '^[a-z0-9][a-z0-9.-]+\.ts\.net$') {
        throw 'Tailscale 尚未连接。请用第 1 步登录，再重新双击第 3 步。'
    }
    $current = Read-TailscaleJson 'serve status --json' 'Serve 当前配置'
    $servePort = 443
    $matchedUrl = $null
    foreach ($candidate in @(443, 8443)) {
        $hostPort = "${dnsName}:$candidate"
        $configurations = @($current) + @($current.Foreground.PSObject.Properties | ForEach-Object Value)
        $occupied = $false
        $matchesConsole = $false
        foreach ($config in $configurations) {
            $web = $config.Web.$hostPort
            $tcp = $config.TCP."$candidate"
            $funnel = $config.AllowFunnel.$hostPort
            if ($web -or $tcp -or $funnel) {
                $occupied = $true
                if ($web.Handlers.'/'.Proxy -eq $consoleUrl -and $tcp.HTTPS -and -not $funnel -and $config -eq $current) {
                    $matchesConsole = $true
                } else {
                    $matchesConsole = $false
                    break
                }
            }
        }
        if ($matchesConsole -or -not $occupied) {
            $servePort = $candidate
            if ($matchesConsole) {
                $matchedUrl = if ($candidate -eq 443) { "https://$dnsName/" } else { "https://$hostPort/" }
            }
            break
        }
        $servePort = 0
    }
    if (-not $servePort) { throw 'Tailscale 的 443 和 8443 都已有其他服务，现有配置保持原样。' }
    if (-not $matchedUrl) {
        Start-ConsoleServe $servePort
        $updated = Read-TailscaleJson 'serve status --json' 'Serve 配置复核'
        $hostPort = "${dnsName}:$servePort"
        if ($updated.Web.$hostPort.Handlers.'/'.Proxy -ne $consoleUrl -or
            -not $updated.TCP."$servePort".HTTPS -or $updated.AllowFunnel.$hostPort) {
            throw 'Tailscale 未确认已启用手机访问。完成窗口里的提示后，重新双击第 3 步。'
        }
        $matchedUrl = if ($servePort -eq 443) { "https://$dnsName/" } else { "https://${dnsName}:$servePort/" }
    }
    return $matchedUrl
}

function Copy-VerifiedAddress([string]$Address) {
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            Set-Clipboard -Value $Address -ErrorAction Stop
            if ((Get-Clipboard -Raw -ErrorAction Stop) -ceq $Address) { return }
        } catch {
            # 其他应用短暂占用剪贴板时，重试并以实际读回内容为准。
        }
        if ($attempt -lt 5) { Start-Sleep -Milliseconds 150 }
    }
    throw '剪贴板写入未通过验证。可手动复制窗口中显示的手机地址。'
}

if ($Step -eq 3) {
    try {
        Write-Host '第 3 步：正在检查控制台和 Tailscale……' -ForegroundColor Cyan
        if (-not $Elevated) {
            Write-PhoneAccessLog 'Step 3 started.'
            Read-RunningPairingKey | Out-Null
        }
        $address = Get-PhoneAccessAddress
        if ($address -cnotmatch '^https://[a-z0-9][a-z0-9.-]+\.ts\.net(?::8443)?/$') {
            throw 'Tailscale 返回的手机地址格式无效。'
        }
        if ($Elevated) {
            if ([IO.Path]::GetFileName($ResultFile) -cnotmatch '^whale-phone-[a-f0-9]{32}\.url$') {
                throw '无法返回手机访问地址。'
            }
            $resultStream = [IO.File]::Open($ResultFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
            try {
                $bytes = [Text.Encoding]::UTF8.GetBytes($address)
                $resultStream.Write($bytes, 0, $bytes.Length)
            } finally { $resultStream.Dispose() }
            Write-PhoneAccessLog 'Elevated helper returned verified Serve address.'
        } else {
            Write-Host "手机访问地址：$address"
            Write-PhoneAccessLog 'Tailscale Serve URL received in desktop session.'
            Copy-VerifiedAddress $address
            Write-PhoneAccessLog 'Clipboard write and readback verified.'
            Write-Host '地址已复制到剪贴板。' -ForegroundColor Cyan
        }
    } catch {
        Write-PhoneAccessLog ("Step 3 failed at line $($_.InvocationInfo.ScriptLineNumber): " + $_.Exception.GetType().Name)
        Write-Host $_.Exception.Message -ForegroundColor Yellow
        if ($Elevated) { Read-Host '按 Enter 关闭这个权限窗口' | Out-Null }
        exit 1
    }
    return
}

if ($Step -eq 1) {
    if (Test-Path -LiteralPath $tailscaleGui) {
        Write-Host '请打开系统托盘中的 Tailscale，并在电脑和手机上登录同一个 Tailscale 网络。'
        Start-Process -FilePath $tailscaleGui
        return
    }
    $msi = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'installers') -Filter 'tailscale-setup-*-amd64.msi' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($msi) {
        $signature = Get-AuthenticodeSignature -LiteralPath $msi.FullName
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*O=Tailscale Inc.,*') {
            throw 'Tailscale 安装文件的数字签名无法验证。请从官网下载安装。'
        }
        Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList ('/i "' + $msi.FullName + '"')
    } else {
        Start-Process 'https://tailscale.com/download/windows'
    }
    return
}

$appRoot = Split-Path $PSScriptRoot -Parent
if ((Split-Path $appRoot -Leaf) -eq 'tools' -and (Test-Path -LiteralPath (Join-Path $appRoot '..\launcher\WhaleLauncher.csproj'))) {
    $appRoot = Split-Path $appRoot -Parent
}
$node = Join-Path $appRoot 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $node)) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw '找不到 Node.js。请从鲸鲸根目录下的「手机远程控制」文件夹启动。' }
    $node = $nodeCommand.Source
}

$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = [System.Threading.Mutex]::new($false, "Local\WhaleGirlRemoteConsole-$sid-$port")
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) {
        $runningKey = Read-RunningPairingKey
        Start-Process $consoleUrl
        Write-Host "控制台已在运行：$consoleUrl"
        Write-Host "配对 Key：$runningKey" -ForegroundColor Cyan
        Read-Host '按 Enter 关闭此窗口。原控制台会继续运行' | Out-Null
        return
    }

    $env:WHALE_CONSOLE_PAIRING_KEY = Get-OrCreatePairingKey
    $env:WHALE_CONSOLE_PORT = [string]$port
    & $node (Join-Path $PSScriptRoot 'server.js') --windows-guide
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
