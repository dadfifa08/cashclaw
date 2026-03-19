param(
  [string]$CateoRoot,
  [int]$SitePort = 3788
)

$ErrorActionPreference = "Stop"
$env:CATEO_SITE_PORT = [string]$SitePort
Set-Location $CateoRoot
npm run site:bridge
