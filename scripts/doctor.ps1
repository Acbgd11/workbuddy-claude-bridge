#requires -Version 5.1
<#
.SYNOPSIS
  WorkBuddy to Claude environment doctor
.DESCRIPTION
  Read-only check. Prints OK/X for each prerequisite.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File doctor.ps1
#>
$ErrorActionPreference = 'SilentlyContinue'

function Test-Item($desc, $ok, $hint = '') {
  $mark = if ($ok) { '[OK]' } else { '[X]' }
  $line = "  $mark  $desc"
  if (-not $ok -and $hint) { $line += "  ->  $hint" }
  $line
}

Write-Host ''
Write-Host '=== WorkBuddy -> Claude  Environment Doctor ===' -ForegroundColor Cyan
Write-Host ''

$wbProc = Get-Process -Name 'WorkBuddy' -ErrorAction SilentlyContinue
$wbInstalled = $false
foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
  if (Get-ItemProperty $root -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'WorkBuddy|CodeBuddy' }) { $wbInstalled = $true; break }
}
Test-Item 'WorkBuddy desktop installed & logged in' ([bool]($wbProc -or $wbInstalled)) 'Install and log in WorkBuddy desktop first'

$nodeVer = $null
try { $nodeVer = (& node --version 2>$null) } catch {}
$nodeRunsTs = $false
if ($nodeVer) {
  $probe = Join-Path $env:TEMP ("gw-ts-probe-" + [guid]::NewGuid().ToString("N") + ".ts")
  try {
    Set-Content -Path $probe -Value 'const n: number = 1' -Encoding ASCII
    & node $probe 2>&1 | Out-Null
    $nodeRunsTs = ($LASTEXITCODE -eq 0)
  } catch {} finally { Remove-Item $probe -Force -ErrorAction SilentlyContinue }
}
$nodeDesc = 'Node runs .ts directly' + $(if ($nodeVer) { " ($nodeVer)" } else { '' })
Test-Item $nodeDesc $nodeRunsTs 'Install the current LTS from nodejs.org'

$authDirs = @(
  "$env:APPDATA\CodeBuddyExtension\Data\Public\auth",
  "$env:LOCALAPPDATA\CodeBuddyExtension\Data\Public\auth"
)
$poolFiles = @()
foreach ($d in $authDirs) {
  if (Test-Path $d) { $poolFiles += Get-ChildItem $d -Filter 'workbuddy-pool-*.info' -ErrorAction SilentlyContinue }
}
$poolOk = $poolFiles.Count -gt 0
Test-Item ("Plaintext credential workbuddy-pool-*.info (found $($poolFiles.Count))") $poolOk 'Add account via xdpool scan, or sync once with workbuddy-switch'

$xdpoolOk = $false
$xdCand = @("$env:USERPROFILE\.deepseek-harness\.workbuddy-xdpool")
if ($env:DSH_HOME) { $xdCand += "$env:DSH_HOME\.workbuddy-xdpool" }
foreach ($d in $xdCand) {
  if (Test-Path $d) { $xdpoolOk = $true; break }
}
Test-Item 'xdpool plugin installed (optional, route A)' $xdpoolOk 'Search workbuddy-xdpool in DSH plugin market (or use route B)'

$wbSwitchOk = [bool]((Get-Process -Name 'wbswitch' -ErrorAction SilentlyContinue) -or
              (Get-AppxPackage -Name 'com.wbswitch.app' -ErrorAction SilentlyContinue) -or
              (Test-Path "$env:LOCALAPPDATA\Programs\com.wbswitch.app"))
Test-Item 'workbuddy-switch APP installed (optional, route B)' $wbSwitchOk 'Install .msix by double-click (or use route A)'

$gw = Get-NetTCPConnection -State Listen -LocalPort 8789 -ErrorAction SilentlyContinue
Test-Item 'Gateway running (port 8789)' ($gw -ne $null) 'Run setup-gateway.ps1 or start.bat'

$task = Get-ScheduledTask -TaskName 'WorkBuddyGateway' -ErrorAction SilentlyContinue
Test-Item 'Auto-start scheduled task registered' ($task -ne $null) 'setup-gateway.ps1 registers it automatically'

Write-Host ''
Write-Host '=== Doctor done ===' -ForegroundColor Cyan
Write-Host 'Fix any [X], then run scripts\setup-gateway.ps1'
Write-Host ''