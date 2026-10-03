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
Write-Host "Без TinyFish/Windsor. AUTO1 през твоя Chrome профил; Shopify и Facebook през директните им API."
Write-Host "Не поставяй пароли или токени в ChatGPT. Въвеждай ги само тук." -ForegroundColor Yellow
Write-Host ""

$shopDomain = Read-Required "Shopify *.myshopify.com домейн"
Write-Host ""
Write-Host "Shopify вход за автоматизацията:" -ForegroundColor Cyan
Write-Host "1 = Dev Dashboard app (Client ID + Client Secret) - препоръчително"
Write-Host "2 = Съществуващ Admin API access token (ако вече имаш legacy custom app)"
$shopMode = Read-Required "Избери 1 или 2" "1"

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
Write-Host "Инсталирам Node зависимостите..." -ForegroundColor Cyan
Push-Location $Repo
try {
  npm install --ignore-scripts --no-package-lock
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

  Write-Host ""
  Write-Host "Сега ще се отвори Chrome за еднократен AUTO1 вход." -ForegroundColor Cyan
  Write-Host "Влез в AUTO1, отвори Instant Purchase / Незабавна покупка и натисни ENTER в конзолата." -ForegroundColor Yellow
  npm run auto1:setup
  if ($LASTEXITCODE -ne 0) { throw "AUTO1 setup failed" }

  Write-Host ""
  Write-Host "Пускам първа реална синхронизация..." -ForegroundColor Cyan
  npm run auto1:sync
  if ($LASTEXITCODE -ne 0) { throw "First sync failed" }

  Write-Host ""
  Write-Host "Инсталирам ежедневната задача за $TaskTime..." -ForegroundColor Cyan
  powershell -ExecutionPolicy Bypass -File (Join-Path $Repo "scripts\install-auto1-task.ps1") -Time $TaskTime
  if ($LASTEXITCODE -ne 0) { throw "Scheduled task install failed" }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "ГОТОВО." -ForegroundColor Green
Write-Host "AUTO1 -> цена с добавките -> Avtomol.com -> Facebook Avtomol.com"
Write-Host "Нови автомобили: ДА | Обновяване на цена: ДА | Изтриване на неналични: НЕ"
