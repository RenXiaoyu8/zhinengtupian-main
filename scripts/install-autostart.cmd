@echo off
setlocal
cd /d "%~dp0\.."

if /i "%~1"=="elevated" goto :main

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo Requesting Administrator...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs -FilePath '%~f0' -ArgumentList 'elevated' -WorkingDirectory '%~dp0\..' -Wait"
  set "RC=%errorlevel%"
  echo.
  echo Elevated installer finished. Exit code: %RC%
  pause
  exit /b %RC%
)

:main
if not exist "server_autostart\install-autostart-task.bat" (
  echo.
  echo ERROR: server_autostart\install-autostart-task.bat not found.
  echo.
  pause
  exit /b 1
)

echo ========================================
echo   Install Server Auto Start
echo ========================================
echo.

echo [1/2] Allowing Windows Firewall port 43123...
netsh advfirewall firewall add rule name="ShangpinCloudAssets-43123" dir=in action=allow protocol=TCP localport=43123 >nul 2>&1
netsh advfirewall firewall add rule name="ShangpinCloudAssets-3000" dir=in action=allow protocol=TCP localport=3000 >nul 2>&1
if errorlevel 1 (
  echo.
  echo ERROR: Firewall setup failed.
  echo.
  pause
  exit /b 1
)
echo Done. Ports 43123 and 3000 are now allowed for LAN access.

echo.
echo [2/2] Installing startup task...
set "NO_PAUSE=1"
call "server_autostart\install-autostart-task.bat"
if errorlevel 1 (
  echo.
  echo ERROR: Startup task installation failed.
  echo.
  pause
  exit /b 1
)

echo.
echo Completed.
echo.
pause
exit /b 0
