param(
  [string]$WebsiteRoot = "C:\Users\dadfi\Projects\cateo",
  [int]$SitePort = 3788,
  [string]$PublicUrl,
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
$NamedTunnelToken = $env:CATEO_CLOUDFLARE_TUNNEL_TOKEN
$ConfiguredPublicUrl = if ($PublicUrl) { $PublicUrl.Trim().TrimEnd('/') } elseif ($env:CATEO_PUBLIC_BACKEND_URL) { $env:CATEO_PUBLIC_BACKEND_URL.Trim().TrimEnd('/') } else { $null }
$TunnelMode = if ($NamedTunnelToken) { "named" } else { "quick" }

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

function Write-State([pscustomobject]$State) {
  $State | ConvertTo-Json | Set-Content $StatePath -Encoding UTF8
}

function Test-ProcessAlive([object]$ProcessId) {
  if (-not $ProcessId) {
    return $false
  }

  try {
    Get-Process -Id ([int]$ProcessId) -ErrorAction Stop | Out-Null
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
    if ($health.ok -ne $true) {
      return $false
    }
  } catch {
    return $false
  }

  $tunnelUrl = [string]$State.tunnelUrl
  if (-not [string]::IsNullOrWhiteSpace($tunnelUrl)) {
    try {
      $publicHealth = Invoke-RestMethod -UseBasicParsing -Uri ("{0}/healthz" -f $tunnelUrl.Trim().TrimEnd('/')) -TimeoutSec 8
      if ($publicHealth.ok -ne $true) {
        return $false
      }
    } catch {
      return $false
    }
  }

  return $true
}

function Stop-ManagedProcesses {
  $state = Read-State
  foreach ($processId in @($state.bridgePid, $state.cloudflaredPid)) {
    if ($processId) {
      try {
        Stop-Process -Id ([int]$processId) -Force -ErrorAction Stop
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

function Reset-LogFile([string]$Path) {
  for ($attempt = 0; $attempt -lt 10; $attempt += 1) {
    try {
      if (Test-Path $Path) {
        Remove-Item $Path -Force
      }
      return
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }

  throw "Failed to reset log file: $Path"
}

function Start-LoggedProcess([string]$FilePath, [string[]]$Arguments, [string]$OutputPath, [string]$ErrorPath) {
  Reset-LogFile -Path $OutputPath
  Reset-LogFile -Path $ErrorPath

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
    npx vercel env add CATEO_BACKEND_URL production --value $BackendUrl --force --yes | Out-Host
    npx vercel --prod --yes | Out-Host
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $CloudflaredExe)) {
  throw "cloudflared not found at $CloudflaredExe"
}

if ($TunnelMode -eq "named" -and -not $ConfiguredPublicUrl) {
  throw "Set CATEO_PUBLIC_BACKEND_URL (or pass -PublicUrl) when using CATEO_CLOUDFLARE_TUNNEL_TOKEN."
}

$previousState = Read-State
if (-not $ForceRestart -and (Test-HealthyState $previousState)) {
  Write-Output "Cateo public stack already healthy."
  Write-Output "Mode: $($previousState.tunnelMode)"
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

if ($TunnelMode -eq "named") {
  $cloudflared = Start-LoggedProcess -FilePath $CloudflaredExe -Arguments @(
    'tunnel',
    'run',
    '--token',
    $NamedTunnelToken,
    '--no-autoupdate'
  ) -OutputPath $TunnelOut -ErrorPath $TunnelErr
  Start-Sleep -Seconds 4
  if (-not (Test-ProcessAlive $cloudflared.Id)) {
    throw "Cloudflare named tunnel process exited before becoming healthy."
  }
  $tunnelUrl = $ConfiguredPublicUrl
  Write-State -State ([pscustomobject]@{
    updatedAt = (Get-Date).ToString('o')
    websiteRoot = $WebsiteRoot
    sitePort = $SitePort
    bridgePid = $bridge.Id
    cloudflaredPid = $cloudflared.Id
    tunnelMode = $TunnelMode
    tunnelUrl = $tunnelUrl
  })
  Wait-Http -Url "$tunnelUrl/healthz" -TimeoutSeconds 90 | Out-Null
} else {
  $cloudflared = Start-LoggedProcess -FilePath $CloudflaredExe -Arguments @(
    'tunnel',
    '--url',
    "http://127.0.0.1:$SitePort",
    '--no-autoupdate'
  ) -OutputPath $TunnelOut -ErrorPath $TunnelErr
  $tunnelUrl = Wait-TunnelUrl -LogPaths @($TunnelOut, $TunnelErr)
  Write-State -State ([pscustomobject]@{
    updatedAt = (Get-Date).ToString('o')
    websiteRoot = $WebsiteRoot
    sitePort = $SitePort
    bridgePid = $bridge.Id
    cloudflaredPid = $cloudflared.Id
    tunnelMode = $TunnelMode
    tunnelUrl = $tunnelUrl
  })
  Wait-Http -Url "$tunnelUrl/healthz" -TimeoutSeconds 90 | Out-Null
}

[pscustomobject]@{
  updatedAt = (Get-Date).ToString('o')
  websiteRoot = $WebsiteRoot
  sitePort = $SitePort
  bridgePid = $bridge.Id
  cloudflaredPid = $cloudflared.Id
  tunnelMode = $TunnelMode
  tunnelUrl = $tunnelUrl
} | ConvertTo-Json | Set-Content $StatePath -Encoding UTF8

if (-not $SkipDeploy -and ($null -eq $previousState -or [string]$previousState.tunnelUrl -ne $tunnelUrl)) {
  try {
    Update-VercelBackendUrl -BackendUrl $tunnelUrl
  } catch {
    Write-Warning ("Failed to update Vercel backend URL or trigger deploy: {0}" -f $_.Exception.Message)
  }
}

Write-Output "Cateo public stack is running."
Write-Output "Mode: $TunnelMode"
Write-Output "Site bridge: http://127.0.0.1:$SitePort"
Write-Output "Tunnel: $tunnelUrl"




