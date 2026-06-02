@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul

echo ========================================
echo   Fix Backend Native Modules and Start
echo ========================================
echo This reinstalls/rebuilds better-sqlite3 for system Node,
echo then starts the backend service.
echo.

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath cmd.exe -ArgumentList '/k','\"\"%~f0\"\"' -Verb RunAs"
  exit /b
)

echo Closing running app/dev server processes...
taskkill /F /IM "electron.exe" >nul 2>&1
taskkill /F /IM "node.exe" >nul 2>&1
taskkill /F /IM "tsx.exe" >nul 2>&1
timeout /t 2 /nobreak >nul

echo Cleaning native module build folders...
if exist "node_modules\better-sqlite3\build" rmdir /s /q "node_modules\better-sqlite3\build" >nul 2>&1
if exist "node_modules\canvas\build" rmdir /s /q "node_modules\canvas\build" >nul 2>&1

echo.
echo Reinstalling dependencies to restore native modules...
call npm.cmd install --include=optional --no-audit --no-fund
if errorlevel 1 (
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)

echo.
echo Rebuilding better-sqlite3 for system Node runtime...
call npm.cmd rebuild better-sqlite3
if errorlevel 1 (
  echo [ERROR] better-sqlite3 rebuild failed.
  pause
  exit /b 1
)

echo.
echo Rebuilding server bundle...
call npm.cmd run build:server
if errorlevel 1 (
  echo [ERROR] server bundle build failed.
  pause
  exit /b 1
)

echo.
echo Starting backend service...
call "%~dp0start-backend.bat"
exit /b %errorlevel%
