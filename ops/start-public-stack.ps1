param(
  [string]$WebsiteRoot = "C:\Users\dadfi\Projects\cateo",
  [int]$SitePort = 3788,
  [switch]$SkipDeploy,
  [switch]$ForceRestart
)

$ErrorActionPreference = "Stop"

$CateoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RuntimeDir = Join-Path $HOME ".cashclaw\runtime"
$StatePath = Join-Path $RuntimeDir "public-stack.json"
$BridgeOut = Join-Path $RuntimeDir "site-bridge.out.log"
$BridgeErr = Join-Path $RuntimeDir "site-bridge.err.log"
$TunnelOut = Join-Path $RuntimeDir "cloudflared.out.log"
$TunnelErr = Join-Path $RuntimeDir "cloudflared.err.log"
$CloudflaredExe = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$PwshCommand = Get-Command pwsh -ErrorAction SilentlyContinue
$PwshExe = if ($PwshCommand) { $PwshCommand.Source } else { "C:\Users\dadfi\AppData\Local\Microsoft\WindowsApps\pwsh.exe" }
$BridgeRunner = (Resolve-Path (Join-Path $PSScriptRoot "run-site-bridge.ps1")).Path

New-Item -ItemType Directory -Force $RuntimeDir | Out-Null

function Read-State {
  if (Test-Path $StatePath) {
    try {
      return Get-Content $StatePath -Raw | ConvertFrom-Json
    } catch {
      return $null
    }
  }

  return $null
}

function Test-ProcessAlive([object]$Pid) {
  if (-not $Pid) {
    return $false
  }

  try {
    Get-Process -Id ([int]$Pid) -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Test-HealthyState([pscustomobject]$State) {
  if (-not $State -or -not $State.sitePort) {
    return $false
  }

  if (-not (Test-ProcessAlive $State.bridgePid) -or -not (Test-ProcessAlive $State.cloudflaredPid)) {
    return $false
  }

  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$($State.sitePort)/healthz" -TimeoutSec 5
    return $health.ok -eq $true
  } catch {
    return $false
  }
}

function Stop-ManagedProcesses {
  $state = Read-State
  foreach ($pid in @($state.bridgePid, $state.cloudflaredPid)) {
    if ($pid) {
      try {
        Stop-Process -Id ([int]$pid) -Force -ErrorAction Stop
      } catch {
      }
    }
  }
}

function Stop-PortListener([int]$Port) {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    try {
      Stop-Process -Id $listener.OwningProcess -Force -ErrorAction Stop
    } catch {
    }
  }
}

function Start-LoggedProcess([string]$FilePath, [string[]]$Arguments, [string]$OutputPath, [string]$ErrorPath) {
  if (Test-Path $OutputPath) { Remove-Item $OutputPath -Force }
  if (Test-Path $ErrorPath) { Remove-Item $ErrorPath -Force }

  return Start-Process -FilePath $FilePath -ArgumentList $Arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $OutputPath -RedirectStandardError $ErrorPath
}

function Wait-Http([string]$Url, [int]$TimeoutSeconds = 30) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      return Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
    } catch {
      Start-Sleep -Seconds 2
    }
  }

  throw "Timed out waiting for $Url"
}

function Wait-TunnelUrl([string[]]$LogPaths, [int]$TimeoutSeconds = 45) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    foreach ($logPath in $LogPaths) {
      if (Test-Path $logPath) {
        $content = Get-Content $logPath -Raw
        $match = [regex]::Match($content, 'https://[-a-z0-9]+\.trycloudflare\.com')
        if ($match.Success) {
          return $match.Value
        }
      }
    }

    Start-Sleep -Seconds 2
  }

  throw "Timed out waiting for Cloudflare tunnel URL"
}

function Update-VercelBackendUrl([string]$BackendUrl) {
  Push-Location $WebsiteRoot
  try {
    try {
      npx vercel env rm CATEO_BACKEND_URL production --yes | Out-Null
    } catch {
    }

    $temp = Join-Path $RuntimeDir "cateo_backend_url.txt"
    [System.IO.File]::WriteAllText($temp, $BackendUrl)
    Get-Content $temp | npx vercel env add CATEO_BACKEND_URL production | Out-Host
    Remove-Item $temp -Force -ErrorAction SilentlyContinue
    npx vercel --prod --yes | Out-Host
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $CloudflaredExe)) {
  throw "cloudflared not found at $CloudflaredExe"
}

$previousState = Read-State
if (-not $ForceRestart -and (Test-HealthyState $previousState)) {
  Write-Output "Cateo public stack already healthy."
  Write-Output "Site bridge: http://127.0.0.1:$($previousState.sitePort)"
  Write-Output "Tunnel: $($previousState.tunnelUrl)"
  exit 0
}

Stop-ManagedProcesses
Stop-PortListener -Port $SitePort

$bridge = Start-LoggedProcess -FilePath $PwshExe -Arguments @(
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  $BridgeRunner,
  '-CateoRoot',
  $CateoRoot,
  '-SitePort',
  "$SitePort"
) -OutputPath $BridgeOut -ErrorPath $BridgeErr
Wait-Http -Url "http://127.0.0.1:$SitePort/healthz" | Out-Null

$cloudflared = Start-LoggedProcess -FilePath $CloudflaredExe -Arguments @(
  'tunnel',
  '--url',
  "http://127.0.0.1:$SitePort",
  '--no-autoupdate'
) -OutputPath $TunnelOut -ErrorPath $TunnelErr
$tunnelUrl = Wait-TunnelUrl -LogPaths @($TunnelOut, $TunnelErr)

if (-not $SkipDeploy -and ($null -eq $previousState -or [string]$previousState.tunnelUrl -ne $tunnelUrl)) {
  Update-VercelBackendUrl -BackendUrl $tunnelUrl
}

[pscustomobject]@{
  updatedAt = (Get-Date).ToString('o')
  websiteRoot = $WebsiteRoot
  sitePort = $SitePort
  bridgePid = $bridge.Id
  cloudflaredPid = $cloudflared.Id
  tunnelUrl = $tunnelUrl
} | ConvertTo-Json | Set-Content $StatePath -Encoding UTF8

Write-Output "Cateo public stack is running."
Write-Output "Site bridge: http://127.0.0.1:$SitePort"
Write-Output "Tunnel: $tunnelUrl"
