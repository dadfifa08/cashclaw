param(
  [string]$WebsiteRoot = "C:\Users\dadfi\Projects\cateo",
  [string]$TaskName = "Cateo Public Stack",
  [int]$HealthCheckMinutes = 5
)

$ErrorActionPreference = "Stop"

$ScriptPath = (Resolve-Path (Join-Path $PSScriptRoot "start-public-stack.ps1")).Path
$PwshCommand = Get-Command pwsh -ErrorAction SilentlyContinue
$PwshExe = if ($PwshCommand) { $PwshCommand.Source } else { "C:\Users\dadfi\AppData\Local\Microsoft\WindowsApps\pwsh.exe" }
$UserId = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
$ActionArguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" -WebsiteRoot `"$WebsiteRoot`""

$action = New-ScheduledTaskAction -Execute $PwshExe -Argument $ActionArguments
$triggerAtLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerWatchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $HealthCheckMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel LeastPrivilege

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($triggerAtLogon, $triggerWatchdog) -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed scheduled task: $TaskName"
