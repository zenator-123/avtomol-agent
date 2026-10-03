param(
  [string]$TaskTime = "21:00"
)

$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$EnvPath = Join-Path $Repo ".env"

function Set-DotEnvValue {
  param([string]$Key, [string]$Value)
  $lines = @()
  if (Test-Path $EnvPath) { $lines = Get-Content $EnvPath -Encoding UTF8 }
  $found = $false
  $out = foreach ($line in $lines) {
    if ($line -match ("^" + [regex]::Escape($Key) + "=")) {
      $found = $true
      "$Key=$Value"
    } else { $line }
  }
  if (-not $found) { $out += "$Key=$Value" }
  $out | Set-Content $EnvPath -Encoding UTF8
}

function Read-Required {
  param([string]$Prompt, [string]$Default = "")
  while ($true) {
    $suffix = if ($Default) { " [$Default]" } else { "" }
    $value = Read-Host ($Prompt + $suffix)
    if (-not $value -and $Default) { return $Default }
    if ($value) { return $value }
  }
}

function Read-SecretPlain {
  param([string]$Prompt)
  $secure = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

Write-Host ""
Write-Host "=== Avtomol FREE local automation setup ===" -ForegroundColor Cyan
Write-Host "No TinyFish/Windsor. AUTO1 uses your Chrome profile; Shopify and Facebook use direct APIs."
Write-Host "Do not paste passwords or tokens into ChatGPT. Enter them only in this local window." -ForegroundColor Yellow
Write-Host ""

$shopDomain = Read-Required "Shopify *.myshopify.com domain"
Write-Host ""
Write-Host "Shopify authentication for automation:" -ForegroundColor Cyan
Write-Host "1 = Dev Dashboard app (Client ID + Client Secret) - recommended"
Write-Host "2 = Existing Admin API access token (legacy custom app)"
$shopMode = Read-Required "Choose 1 or 2" "1"

Set-DotEnvValue "SHOPIFY_SHOP_DOMAIN" $shopDomain
if ($shopMode -eq "2") {
  $shopToken = Read-SecretPlain "Shopify Admin API access token"
  Set-DotEnvValue "SHOPIFY_ACCESS_TOKEN" $shopToken
  Set-DotEnvValue "SHOPIFY_CLIENT_ID" ""
  Set-DotEnvValue "SHOPIFY_CLIENT_SECRET" ""
} else {
  $shopClientId = Read-Required "Shopify Dev Dashboard App Client ID"
  $shopClientSecret = Read-SecretPlain "Shopify Dev Dashboard App Client Secret"
  Set-DotEnvValue "SHOPIFY_ACCESS_TOKEN" ""
  Set-DotEnvValue "SHOPIFY_CLIENT_ID" $shopClientId
  Set-DotEnvValue "SHOPIFY_CLIENT_SECRET" $shopClientSecret
}

$fbPageId = Read-Required "Facebook Page ID" "1197473636784239"
$fbToken = Read-SecretPlain "Facebook Page/System User access token (pages_manage_posts)"
Set-DotEnvValue "FACEBOOK_PAGE_ID" $fbPageId
Set-DotEnvValue "FACEBOOK_PAGE_ACCESS_TOKEN" $fbToken
Set-DotEnvValue "AUTO1_FEE_VAT_PERCENT" "22"
Set-DotEnvValue "AUTO1_MIN_PROFIT_EUR" "500"
Set-DotEnvValue "ALLOW_DELETIONS" "false"
Set-DotEnvValue "ALLOW_ADDITIONS" "true"
Set-DotEnvValue "ALLOW_UPDATES" "true"
Set-DotEnvValue "SYNC_DRY_RUN" "false"

Write-Host ""
Write-Host "Checking Node.js / npm..." -ForegroundColor Cyan

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue

if (-not $nodeCmd -or -not $npmCmd) {
  Write-Host "Node.js is not installed." -ForegroundColor Yellow
  $winget = Get-Command winget -ErrorAction SilentlyContinue

  if ($winget) {
    Write-Host "Installing Node.js LTS with winget..." -ForegroundColor Yellow
    winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Node.js installation with winget failed" }
  } else {
    Write-Host "winget was not found. Downloading Node.js LTS directly from nodejs.org..." -ForegroundColor Yellow
    $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing
    $release = $index | Where-Object { $_.lts -and ($_.files -contains "win-x64-msi") } | Select-Object -First 1
    if (-not $release) { throw "Could not find a Windows x64 Node.js LTS installer" }

    $version = [string]$release.version
    $msiName = "node-$version-x64.msi"
    $msiUrl = "https://nodejs.org/dist/$version/$msiName"
    $msiPath = Join-Path $env:TEMP $msiName

    Write-Host ("Downloading " + $msiUrl) -ForegroundColor Cyan
    Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing

    $sig = Get-AuthenticodeSignature $msiPath
    if ($sig.Status -ne "Valid") {
      Remove-Item $msiPath -Force -ErrorAction SilentlyContinue
      throw "Downloaded Node.js installer signature is not valid"
    }

    Write-Host "Windows may ask for administrator permission. Choose Yes." -ForegroundColor Yellow
    $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", ('"' + $msiPath + '"'), "/qn", "/norestart") -Verb RunAs -Wait -PassThru
    Remove-Item $msiPath -Force -ErrorAction SilentlyContinue
    if ($proc.ExitCode -ne 0) { throw ("Node.js installer failed with exit code " + $proc.ExitCode) }
  }

  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  $npmCmd = Get-Command npm -ErrorAction SilentlyContinue

  if (-not $nodeCmd -or -not $npmCmd) {
    Write-Host "Node.js was installed, but this window has not picked up the new PATH yet." -ForegroundColor Yellow
    Write-Host "Close this window and run SETUP-AVTOMOL-FREE.cmd again." -ForegroundColor Yellow
    exit 0
  }
}

Write-Host ("Node: " + (& node --version)) -ForegroundColor Green
Write-Host ("npm:  " + (& npm --version)) -ForegroundColor Green

Write-Host ""
Write-Host "Installing Node dependencies..." -ForegroundColor Cyan
Push-Location $Repo
try {
  npm install --ignore-scripts --no-package-lock
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

  Write-Host ""
  Write-Host "Chrome will open for the one-time AUTO1 login." -ForegroundColor Cyan
  Write-Host "Log in to AUTO1, open Instant Purchase, then press ENTER in this console." -ForegroundColor Yellow
  npm run auto1:setup
  if ($LASTEXITCODE -ne 0) { throw "AUTO1 setup failed" }

  Write-Host ""
  Write-Host "Starting the first real synchronization..." -ForegroundColor Cyan
  npm run auto1:sync
  if ($LASTEXITCODE -ne 0) { throw "First sync failed" }

  Write-Host ""
  Write-Host "Installing the daily task for $TaskTime..." -ForegroundColor Cyan
  powershell -ExecutionPolicy Bypass -File (Join-Path $Repo "scripts\install-auto1-task.ps1") -Time $TaskTime
  if ($LASTEXITCODE -ne 0) { throw "Scheduled task install failed" }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "DONE." -ForegroundColor Green
Write-Host "AUTO1 -> marked-up price -> Avtomol.com -> Facebook Avtomol.com"
Write-Host "New vehicles: YES | Price updates: YES | Delete unavailable vehicles: NO"
