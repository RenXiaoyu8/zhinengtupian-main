@echo off
setlocal
cd /d "%~dp0"

if not exist "scripts\install-autostart.cmd" (
  echo ERROR: scripts\install-autostart.cmd not found.
  pause
  exit /b 1
)

echo ========================================
echo   Install Server Auto Start
echo ========================================
echo.

call "scripts\install-autostart.cmd"
set "RC=%errorlevel%"
echo.
echo Install script finished. Exit code: %RC%
pause
exit /b %RC%
