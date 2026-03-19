param(
  [string]$WebsiteRoot = "C:\Users\dadfi\Projects\cateo",
  [string]$TaskName = "Cateo Public Stack Watchdog",
  [int]$HealthCheckMinutes = 5
)

$ErrorActionPreference = "Stop"

$ScriptPath = (Resolve-Path (Join-Path $PSScriptRoot "start-public-stack.ps1")).Path
$PwshCommand = Get-Command pwsh -ErrorAction SilentlyContinue
$PwshExe = if ($PwshCommand) { $PwshCommand.Source } else { "C:\Users\dadfi\AppData\Local\Microsoft\WindowsApps\pwsh.exe" }
$TaskCommand = '"' + $PwshExe + '" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $ScriptPath + '" -WebsiteRoot "' + $WebsiteRoot + '"'

& schtasks /Create /F /SC MINUTE /MO $HealthCheckMinutes /RL LIMITED /TN $TaskName /TR $TaskCommand | Out-Host
& schtasks /Run /TN $TaskName | Out-Host

Write-Output "Installed scheduled task: $TaskName"
