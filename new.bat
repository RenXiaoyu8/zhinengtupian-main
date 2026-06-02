@echo off
setlocal
cd /d "%~dp0"

if not exist "package.json" (
  echo ERROR: package.json not found.
  pause
  exit /b 1
)

if not exist "scripts\publish-release.cmd" (
  echo ERROR: scripts\publish-release.cmd not found.
  pause
  exit /b 1
)

echo ========================================
echo   One-click Publish + Start Backend
echo ========================================
echo.
echo This script will:
echo   1. close old app/backend processes
echo   2. rebuild and publish a new release
echo   3. start backend service after publish succeeds
echo.

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator...
  powershell -NoProfile -Command "Start-Process -FilePath cmd.exe -ArgumentList '/k','\"\"%~f0\"\"' -Verb RunAs"
  exit /b
)

echo Closing possible running app/dev server processes...
schtasks /End /TN "ShangpinCloudAssets-Server" >nul 2>&1
for %%P in (electron.exe node.exe tsx.exe) do taskkill /F /IM "%%P" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process | Where-Object { $_.ProcessName -like '*Shangpin*' -or $_.ProcessName -like '*CloudAssets*' } | Stop-Process -Force -ErrorAction SilentlyContinue" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$self=$PID; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $self -and ($_.CommandLine -match 'start-backend\.ps1' -or $_.CommandLine -match 'server-bundle\.cjs' -or $_.CommandLine -match 'ShangpinCloudAssets') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$pids = Get-NetTCPConnection -LocalPort 43123 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($processId in $pids) { taskkill /PID $processId /T /F | Out-Null }" >nul 2>&1

timeout /t 4 /nobreak >nul

echo Cleaning native build cache...
if exist "node_modules\better-sqlite3\build\Release\better_sqlite3.node" (
  attrib -R "node_modules\better-sqlite3\build\Release\better_sqlite3.node" >nul 2>&1
  del /f /q "node_modules\better-sqlite3\build\Release\better_sqlite3.node" >nul 2>&1
  if exist "node_modules\better-sqlite3\build\Release\better_sqlite3.node" (
    echo.
    echo [ERROR] better_sqlite3.node is still locked.
    echo Please close the app/backend windows, or reboot this computer, then publish again.
    pause
    exit /b 1
  )
)
if exist "node_modules\better-sqlite3\build" rmdir /s /q "node_modules\better-sqlite3\build" >nul 2>&1
if exist "node_modules\canvas\build" rmdir /s /q "node_modules\canvas\build" >nul 2>&1

echo.
set "NO_PAUSE=1"
call "scripts\publish-release.cmd"
set "RC=%errorlevel%"
if not "%RC%"=="0" (
  echo.
  echo [ERROR] Publish failed. Exit code: %RC%
  pause
  exit /b %RC%
)

echo.
echo Backing up this release to GitHub...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\github-backup-release.ps1"
set "RC=%errorlevel%"
if not "%RC%"=="0" (
  echo.
  echo [WARN] GitHub backup failed. Exit code: %RC%
  echo Publish already succeeded. Backend will continue to start.
  echo You can retry backup later:
  echo   powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\github-backup-release.ps1"
)

echo.
echo Publish succeeded. Starting backend...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-backend.ps1" -Detached -NoPause
set "RC=%errorlevel%"
if not "%RC%"=="0" (
  echo.
  echo [WARN] Backend did not report ready on first attempt. Exit code: %RC%
  echo Retrying once...
  timeout /t 3 /nobreak >nul
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-backend.ps1" -Detached -NoPause
  set "RC=%errorlevel%"
  if not "%RC%"=="0" (
    echo.
    echo [ERROR] Backend did not report ready. Exit code: %RC%
    echo Log: C:\ProgramData\ShangpinCloudAssets\backend-launch.log
    echo Log: C:\ProgramData\ShangpinCloudAssets\manual-backend.log
    echo You can run start-backend.bat to inspect logs.
    pause
    exit /b %RC%
  )
)

schtasks /Run /TN "ShangpinCloudAssets-Server" >nul 2>&1

echo.
echo [OK] Release published and backend started.
echo Manual fallback: start-backend.bat
echo.
pause
exit /b 0
