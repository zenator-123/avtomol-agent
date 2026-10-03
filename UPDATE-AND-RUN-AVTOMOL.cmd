@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo === Avtomol update and run ===
echo Updating the automation files from GitHub...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $base='https://raw.githubusercontent.com/zenator-123/avtomol-agent/main/'; $files=@('scripts/auto1-profile-feed.js','scripts/daily-vehicle-sync.js','scripts/auto1-sync-runner.js','scripts/install-auto1-task.ps1','package.json'); foreach($f in $files){$dst=Join-Path (Get-Location) $f; $dir=Split-Path $dst -Parent; if(!(Test-Path $dir)){New-Item -ItemType Directory -Force -Path $dir ^| Out-Null}; Write-Host ('Downloading '+$f); (New-Object System.Net.WebClient).DownloadFile($base+$f,$dst)}; Write-Host 'Update complete.' -ForegroundColor Green"
if errorlevel 1 goto :fail
echo.
echo Installing/updating Node dependencies...
call npm install --ignore-scripts --no-package-lock
if errorlevel 1 goto :fail
echo.
echo Running AUTO1 - Avtomol synchronization...
call npm run auto1:sync
if errorlevel 1 goto :fail
echo.
echo Installing daily task for 21:00...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-auto1-task.ps1" -Time "21:00"
if errorlevel 1 goto :fail
echo.
echo DONE.
echo New vehicles: YES
echo Price updates: YES
echo Delete unavailable vehicles: NO
echo.
pause
exit /b 0

:fail
echo.
echo ERROR: The update or synchronization failed.
echo Take a screenshot of this window and send it in ChatGPT.
pause
exit /b 1
