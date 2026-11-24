@echo off
setlocal EnableExtensions
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
echo Builds and verifies a new release while the current backend stays online.
echo.
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting Administrator...
  powershell -NoProfile -Command "Start-Process -FilePath cmd.exe -ArgumentList '/k','\"\"%~f0\"\"' -Verb RunAs"
  exit /b
)

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
echo Starting the verified backend...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-backend.ps1" -Detached -NoPause
if errorlevel 1 (
  echo [ERROR] Backend did not become ready. See C:\ProgramData\ShangpinCloudAssets\backend-launch.log
  pause
  exit /b 1
)

echo Backing up this release to GitHub...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\github-backup-release.ps1"
if errorlevel 1 echo [WARN] GitHub backup failed. The backend is already running.
echo [OK] Release published and backend started.
echo Manual fallback: start-backend.bat
echo.
pause
exit /b 0
