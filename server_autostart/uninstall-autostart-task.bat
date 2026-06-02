@echo off
setlocal

if /i "%~1"=="elevated" goto :main

REM Request admin
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs -FilePath '%~f0' -ArgumentList 'elevated' -WorkingDirectory '%~dp0' -Wait"
  exit /b
)

:main
chcp 65001 >nul
cd /d "%~dp0"

set "TASK_NAME=ShangpinCloudAssets-Server"
set "LOG_DIR=%ProgramData%\ShangpinCloudAssets"
set "BOOT_WRAPPER=%LOG_DIR%\boot-run.ps1"
set "STARTUP_VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ShangpinCloudAssets-Server.vbs"

echo Deleting scheduled task: %TASK_NAME%
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Unregister-ScheduledTask -TaskName '%TASK_NAME%' -Confirm:\$false -ErrorAction SilentlyContinue | Out-Null } catch {}"
del "%BOOT_WRAPPER%" >nul 2>&1
del "%STARTUP_VBS%" >nul 2>&1

echo.
echo Done.
pause

