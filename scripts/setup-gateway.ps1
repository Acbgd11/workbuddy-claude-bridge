#requires -Version 5.1
param([string]$GatewayDir)
$ErrorActionPreference = "Stop"

# 默认网关位置：本脚本所在的 skill 文件夹内的 workbuddy-anthropic-gateway
if (-not $GatewayDir) {
  $candidate = Join-Path (Split-Path $PSScriptRoot -Parent) "workbuddy-anthropic-gateway"
  if (Test-Path (Join-Path $candidate "src\server.ts")) { $GatewayDir = $candidate }
  elseif (Test-Path (Join-Path $PSScriptRoot "..\..\workbuddy-anthropic-gateway\src\server.ts")) {
    $GatewayDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..\workbuddy-anthropic-gateway")).Path
  }
}
function Info($m){ Write-Host "  [*] $m" -ForegroundColor Gray }
function Ok($m){ Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m){ Write-Host "  [!] $m" -ForegroundColor Yellow }
function Die($m){ Write-Host "  [X] $m" -ForegroundColor Red; exit 1 }
Write-Host ""
Write-Host "=== WorkBuddy -> Claude One-shot Setup ===" -ForegroundColor Cyan
if (-not $GatewayDir) { Die "Cannot locate the gateway folder. Pass it explicitly: .\setup-gateway.ps1 -GatewayDir <path to workbuddy-anthropic-gateway>" }
$GatewayDir = $GatewayDir.TrimEnd("\")
if (-not (Test-Path "$GatewayDir\src\server.ts")) { Die "src/server.ts not found in $GatewayDir" }
if (-not (Test-Path "$GatewayDir\config.json")) { Die "config.json not found in $GatewayDir" }
$nodeVer = $null
try { $nodeVer = (& node --version 2>$null) } catch {}
if (-not $nodeVer) { Die "Node.js is not installed. Get the current LTS from nodejs.org." }
# 需要 Node 能直接跑 .ts（type stripping）。各版本默认开启的门槛不同（22.6 起需加标志、22.18/23.6 起默认），
# 不做版本号比较，直接跑一个最小 .ts 探针实测。
$probe = Join-Path $env:TEMP ("gw-ts-probe-" + [guid]::NewGuid().ToString("N") + ".ts")
$nodeRunsTs = $false
$prevEap = $ErrorActionPreference
try {
  Set-Content -Path $probe -Value 'const n: number = 1' -Encoding ASCII
  $ErrorActionPreference = 'SilentlyContinue'
  & node $probe 2>&1 | Out-Null
  $nodeRunsTs = ($LASTEXITCODE -eq 0)
} catch {} finally {
  $ErrorActionPreference = $prevEap
  Remove-Item $probe -Force -ErrorAction SilentlyContinue
}
if (-not $nodeRunsTs) { Die "Node $nodeVer cannot run TypeScript directly. Install the current LTS (22.18+ or newer) from nodejs.org, then re-run." }
Ok "Node $nodeVer (runs .ts directly)"
$existing = Get-NetTCPConnection -State Listen -LocalPort 8789 -ErrorAction SilentlyContinue
if ($existing) {
  Info "8789 in use (PID $($existing[0].OwningProcess)), restarting"
  Stop-Process -Id $existing[0].OwningProcess -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
Start-Process -FilePath "node.exe" -ArgumentList "src/server.ts" -WorkingDirectory $GatewayDir -WindowStyle Hidden
Start-Sleep -Seconds 4
$health = $null
try { $health = Invoke-WebRequest -Uri "http://127.0.0.1:8789/healthz" -TimeoutSec 10 -UseBasicParsing } catch {}
if (-not $health -or $health.StatusCode -ne 200) { Die "Gateway failed. Run manually: cd $GatewayDir; node src/server.ts" }
$hj = $health.Content | ConvertFrom-Json
Ok ("Gateway up, accounts: " + $hj.accounts.Count)
if ($hj.accounts.Count -eq 0) { Warn "No usable accounts (all encrypted-wrapped). Add via xdpool or workbuddy-switch, then re-run." }
$keyPath = "$GatewayDir\data\api-key.txt"
if (-not (Test-Path $keyPath)) { Die "api-key.txt not generated" }
$apiKey = (Get-Content $keyPath -Raw).Trim()
if (-not $apiKey) { Die "api-key.txt is empty" }
$profileId = "00000000-0000-4000-8000-000000157210"
$profile = @{
  coworkEgressAllowedHosts = @("*")
  disableDeploymentModeChooser = $true
  inferenceGatewayApiKey = $apiKey
  inferenceGatewayAuthScheme = "bearer"
  inferenceGatewayBaseUrl = "http://127.0.0.1:8789"
  inferenceProvider = "gateway"
  modelDiscoveryEnabled = $true
  inferenceModels = @(
    @{ name = "claude-haiku-1"; labelOverride = "GLM 5.3 Flash"; anthropicFamilyTier = "haiku" },
    @{ name = "claude-haiku-2"; labelOverride = "DeepSeek 4.1 Flash"; anthropicFamilyTier = "haiku" },
    @{ name = "claude-haiku-3"; labelOverride = "Hy3"; anthropicFamilyTier = "haiku" }
  )
} | ConvertTo-Json -Depth 6
$targets = @(
  "$env:LOCALAPPDATA\Claude-3p\configLibrary",
  "$env:LOCALAPPDATA\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Claude-3p\configLibrary"
)
foreach ($dir in $targets) {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  Set-Content "$dir\$profileId.json" $profile -Encoding UTF8
}
$cc = "$env:LOCALAPPDATA\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Claude"
New-Item -ItemType Directory -Path $cc -Force | Out-Null
Set-Content "$cc\claude_desktop_config.json" '{\"deploymentMode\":\"3p\"}' -Encoding UTF8
Ok "Desktop profile written (real + MSIX container)"
# 隐藏启动器:wscript 以窗口样式 0 拉起 node,计划任务触发时不再弹黑色终端窗
$vbs = Join-Path $GatewayDir "hidden-start.vbs"
Set-Content -Path $vbs -Value 'CreateObject("WScript.Shell").Run "node src/server.ts", 0, True' -Encoding ASCII
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + $vbs + '"') -WorkingDirectory $GatewayDir
# 双触发器:登录拉起 + 每 5 分钟自愈轮询(休眠唤醒不触发登录事件,轮询兜底)
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$triggerPoll  = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
# IgnoreNew:已在跑就忽略,轮询不会起重复进程;失败自动重试 3 次
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
try {
  Register-ScheduledTask -TaskName "WorkBuddyGateway" -Action $action -Trigger $triggerLogon,$triggerPoll -Settings $settings -Force | Out-Null
  Ok "Auto-start task registered (WorkBuddyGateway: logon + 5-min self-heal, hidden window)"
} catch { Warn "Task registration failed: $_" }
Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host "Next: fully quit Claude Desktop (tray icon -> Quit), reopen, pick any model."
Write-Host "Troubleshooting: references\pitfalls.md"
