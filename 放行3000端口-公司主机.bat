@echo off
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator...
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
chcp 65001 >nul
echo Adding firewall rule for port 43123...
netsh advfirewall firewall add rule name="ShangpinCloudAssets-43123" dir=in action=allow protocol=TCP localport=43123
netsh advfirewall firewall add rule name="ShangpinCloudAssets-3000" dir=in action=allow protocol=TCP localport=3000
if errorlevel 1 (
  echo Failed. Run this script as Administrator.
  echo.
  echo Or add manually:
  echo   Windows Defender Firewall - Advanced - Inbound Rules
  echo   New Rule - Port - TCP 43123 - Allow
) else (
  echo Done. Ports 43123 and 3000 are now allowed for LAN access.
)
if not "%NO_PAUSE%"=="1" pause
