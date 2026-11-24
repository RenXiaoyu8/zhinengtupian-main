@echo off
echo ========================================
echo   Rebuild and Start Backend
echo ========================================
echo.

cd /d "%~dp0"

echo Step 1: Rebuild server bundle...
call npm run build:server
if %errorlevel% neq 0 (
  echo [ERROR] Build failed
  pause
  exit /b 1
)

echo.
echo Step 2: Stop existing backend...
taskkill /F /IM node.exe >nul 2>&1

echo.
echo Step 3: Start backend...
start "Backend Server" cmd /k "node electron\server-bundle.cjs"

echo.
echo [OK] Backend started in new window
echo Check the backend window for console logs
echo.
pause
