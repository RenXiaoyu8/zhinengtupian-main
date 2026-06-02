@echo off
setlocal

if /i "%~1"=="elevated" goto :main

REM Request admin
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs -FilePath '%~f0' -ArgumentList 'elevated' -WorkingDirectory '%~dp0' -Wait"
  if errorlevel 1 (
    echo.
    echo [ERROR] Administrator permission was not granted.
    if not "%NO_PAUSE%"=="1" pause
  )
  exit /b
)

:main
chcp 65001 >nul
for %%I in ("%~dp0.") do set "SCRIPT_DIR=%%~fI"
cd /d "%SCRIPT_DIR%"

if not exist "%SCRIPT_DIR%\install-autostart-task.ps1" (
  echo [ERROR] Missing: %SCRIPT_DIR%\install-autostart-task.ps1
  if not "%NO_PAUSE%"=="1" pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\install-autostart-task.ps1"
set "RC=%errorlevel%"
if %RC% neq 0 (
  echo.
  echo [ERROR] Install task failed. Exit code: %RC%
  if not "%NO_PAUSE%"=="1" pause
  exit /b %RC%
)

if not "%NO_PAUSE%"=="1" pause
exit /b 0

