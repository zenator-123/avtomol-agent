param(
  [string]$TaskName = "Avtomol AUTO1 Daily Sync",
  [string]$Time = "21:00"
)

$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Node = (Get-Command node -ErrorAction Stop).Source
$Runner = Join-Path $Repo "scripts\auto1-sync-runner.js"

$Action = New-ScheduledTaskAction -Execute $Node -Argument ('"' + $Runner + '"') -WorkingDirectory $Repo
$Trigger = New-ScheduledTaskTrigger -Daily -At $Time
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Влиза през запазената AUTO1 сесия, проверява наличните коли и добавя/обновява Avtomol.com. Не трие липсващи автомобили." -Force

Write-Host "Готово: $TaskName ще се стартира всеки ден в $Time."
