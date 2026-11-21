#relay 演示脚本：起中继、验一遍、再把桥接指过来。
#只做“把两个进程按正确顺序拉起来”这件事，参数化得越少越不容易用错。
param(
  [switch]$Smoke,                       # 只起中继并本地发一条假消息，不碰微信
  [switch]$RestartBridge,               # 先把正在跑的桥接停掉（会杀掉 python 的桥接进程）
  [string]$BridgeRepo = 'D:\whale-girl', # 桥接所在的仓库副本（通常是装好的那份）
  [string]$Message = '在吗，我想做个官网'
)

$ErrorActionPreference = 'Stop'
$relayDir = $PSScriptRoot
$port = 8790
$base = "http://127.0.0.1:$port"

function Test-Relay {
  try {
    $r = Invoke-RestMethod -Uri "$base/healthz" -TimeoutSec 2
    return ($r.ok -eq $true -and $r.service -eq 'whale-girl')
  } catch { return $false }
}

if (-not (Test-Path (Join-Path $relayDir 'config.json'))) {
  Write-Host '缺少 relay/config.json，先复制 config.example.json 并填 DEEPSEEK_API_KEY。' -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Relay)) {
  Write-Host "启动中继（端口 $port）…"
  $relay = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $relayDir -PassThru -WindowStyle Hidden
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Relay) { break }
  }
  if (-not (Test-Relay)) { Write-Host '中继没起来，到 state/relay.log 看原因。' -ForegroundColor Red; exit 1 }
  Write-Host '中继已启动。' -ForegroundColor Green
} else {
  $relay = $null
  Write-Host "中继已在运行（$base）。" -ForegroundColor Green
}

try {
  if ($Smoke) {
    Write-Host '本地发一条假消息（会真的跑一轮前台，需要 key）…'
    $payload = @{ chat_id = 'wxid_smoke'; text = $Message; msg_id = "smoke-$(Get-Date -Format HHmmss)"; nickname = '自测'; chat_type = 'private'; at_me = $false } | ConvertTo-Json
    # PowerShell 5.1 会把字符串按 ANSI 发出去，中文到 relay 就是乱码，必须先转成 UTF-8 字节。
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $reply = Invoke-RestMethod -Uri "$base/webhook/wechat" -Method Post -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 600
    Write-Host ('前台回复：' + $reply.reply) -ForegroundColor Cyan
    exit 0
  }

  if ($RestartBridge) {
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
      Where-Object { $_.CommandLine -like '*wechatauto_bridge.py*' } |
      ForEach-Object { Write-Host "停掉旧桥接 pid=$($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Seconds 2
  }

  $env:WHALE_BOT_URL = "$base/webhook/wechat"
  Write-Host "桥接连到 $env:WHALE_BOT_URL（Ctrl+C 结束桥接）"
  & (Join-Path $BridgeRepo 'runtime\python\python.exe') -u examples\wechatauto_bridge.py
} finally {
  if ($relay -and -not $relay.HasExited) {
    Write-Host '停止中继…'
    Stop-Process -Id $relay.Id -Force
  }
}
