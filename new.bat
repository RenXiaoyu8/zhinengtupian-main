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
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-running-app.ps1" -Root "%~dp0"

timeout /t 1 /nobreak >nul

echo Cleaning native build cache...
if exist "node_modules\better-sqlite3\build\Release\better_sqlite3.node" (
  for /l %%i in (1,1,5) do (
    attrib -R "node_modules\better-sqlite3\build\Release\better_sqlite3.node" >nul 2>&1
    del /f /q "node_modules\better-sqlite3\build\Release\better_sqlite3.node" >nul 2>&1
    if not exist "node_modules\better-sqlite3\build\Release\better_sqlite3.node" goto native_cache_cleaned
    echo better_sqlite3.node is locked, retrying close step %%i/5...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-running-app.ps1" -Root "%~dp0" >nul 2>&1
    timeout /t 1 /nobreak >nul
  )
  echo.
  echo [ERROR] better_sqlite3.node is still locked.
  echo Please close the app/backend windows, or reboot this computer, then publish again.
  echo You can also run as Administrator:
  echo   taskkill /F /T /IM node.exe
  pause
  exit /b 1
)
:native_cache_cleaned
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
