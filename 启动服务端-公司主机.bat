@echo off
chcp 65001 >nul
cd /d "%~dp0"

set NODE_ENV=production
set PORT=43123
set STATIC_DIR=%cd%\dist
set ASSETS_ROOT=D:\尚品易站图片
REM DB/users/product_folders 放在网盘下「程序图片勿动」，重启后删除不会复活
REM set DATABASE_PATH=%cd%\visualflow.db

echo ========================================
echo   Shangpin Cloud Assets - Server
echo ========================================
echo Node:
where node >nul 2>&1
if errorlevel 1 (
  echo [Error] Node.js not found. Install Node.js (18+ recommended 20+) then run again.
  pause
  exit /b 1
)
node -v
echo.
echo STATIC_DIR=%STATIC_DIR%
echo ASSETS_ROOT=%ASSETS_ROOT%
echo DATABASE in: %ASSETS_ROOT%\程序图片勿动\visualflow.db
echo PORT=%PORT%
echo ========================================

if not exist "%STATIC_DIR%" (
  echo [Error] dist not found. Please run: npm run build
  pause
  exit /b 1
)

REM Ensure port 43123 is free
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":%PORT% " ^| findstr /C:"LISTENING" /C:"监听"') do taskkill /PID %%a /F >nul 2>&1
timeout /t 1 /nobreak >nul

node electron\server-bundle.cjs
pause
