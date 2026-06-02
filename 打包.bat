@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

if not exist "package.json" (
  echo ERROR: package.json not found. Run this .bat from project root.
  pause
  exit /b 1
)

REM Ensure running in cmd with admin (use /k so new window stays open)
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator...
  powershell -NoProfile -Command "Start-Process -FilePath cmd.exe -ArgumentList '/k','\"\"%~f0\"\"' -Verb RunAs"
  exit /b
)

echo ========================================
echo   Build
echo ========================================
echo.
echo IMPORTANT:
echo - Please close ALL running instances:
echo   - Electron app (Shangpin Cloud Assets)
echo   - any "npm run dev" / "tsx server.ts"
echo   - Cursor/VS Code terminals running node
echo (otherwise better-sqlite3 may be locked and rebuild will fail)
echo.
echo Cleaning native module build cache...
if exist "node_modules\better-sqlite3\build\Release\better_sqlite3.node" (
  echo Deleting locked file...
  del /f /q "node_modules\better-sqlite3\build\Release\better_sqlite3.node" >nul 2>&1
  timeout /t 1 /nobreak >nul
  del /f /q "node_modules\better-sqlite3\build\Release\better_sqlite3.node" >nul 2>&1
)
if exist "node_modules\better-sqlite3\build" rmdir /s /q "node_modules\better-sqlite3\build" >nul 2>&1
if exist "node_modules\canvas\build" rmdir /s /q "node_modules\canvas\build" >nul 2>&1
echo.
echo Building...
echo ========================================

call npm run electron:build

if errorlevel 1 (
  echo.
  echo Build failed. Try "Run as administrator" if permission error.
  pause
  exit /b 1
)

set "OUT_DIR=release\ShangpinCloudAssets"
if exist "release\win-unpacked" (
  if exist "%OUT_DIR%" (
    rmdir /s /q "%OUT_DIR%"
  )
  rename "release\win-unpacked" "ShangpinCloudAssets"
)
if not exist "%OUT_DIR%" (
  echo.
  echo Build completed but output folder not found: %OUT_DIR%\
  pause
  exit /b 1
)

echo.
echo Done. Output: %OUT_DIR%\
echo Auto-update ready folder generated.
echo ========================================
pause
