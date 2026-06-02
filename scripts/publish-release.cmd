@echo off
setlocal
cd /d "%~dp0\.."

set "PY_CMD="
where python >nul 2>&1
if %errorlevel% equ 0 set "PY_CMD=python"
if not defined PY_CMD (
  where py >nul 2>&1
  if %errorlevel% equ 0 set "PY_CMD=py -3"
)

if not defined PY_CMD (
  echo.
  echo ERROR: Python not found.
  echo Install Python 3 and make sure python or py works in cmd.
  echo.
  if not "%NO_PAUSE%"=="1" pause
  exit /b 1
)

echo.
%PY_CMD% ".\scripts\publish_release.py"
if errorlevel 1 (
  echo.
  echo ERROR: Publish failed.
  echo.
  if not "%NO_PAUSE%"=="1" pause
  exit /b 1
)

echo.
echo Publish complete.
echo.
if not "%NO_PAUSE%"=="1" pause
