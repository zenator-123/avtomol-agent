param(
  [string]$TaskName = "Avtomol AUTO1 Daily Sync",
  [string]$Time = "21:00"
)

$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Node = (Get-Command node -ErrorAction Stop).Source
$Runner = Join-Path $Repo "scripts\auto1-sync-runner.js"

$Action = New-ScheduledTaskAction -Execute $Node -Argument ("`"" + $Runner + "`"") -WorkingDirectory $Repo
$Trigger = New-ScheduledTaskTrigger -Daily -At $Time
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Checks AUTO1, adds new vehicles to Avtomol.com, updates prices, never deletes unavailable vehicles." -Force

Write-Host ("Scheduled task installed: " + $TaskName + " at " + $Time) -ForegroundColor Green
