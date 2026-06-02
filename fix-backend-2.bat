@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul

echo ========================================
echo   Fix Backend and Restore Auto-Start
echo ========================================

echo Step 1: Closing running processes...
taskkill /F /IM "electron.exe" >nul 2>&1
taskkill /F /IM "node.exe" >nul 2>&1
taskkill /F /IM "tsx.exe" >nul 2>&1
timeout /t 2 /nobreak >nul

echo Step 2: Cleaning better-sqlite3 build...
if exist "node_modules\better-sqlite3\build" (
  rmdir /s /q "node_modules\better-sqlite3\build" >nul 2>&1
)

echo Step 3: Rebuilding native modules for system Node...
call npm.cmd rebuild better-sqlite3
if errorlevel 1 (
  echo [WARN] npm rebuild failed, trying direct install...
  call npm.cmd install better-sqlite3@12.6.2 --no-save
  if errorlevel 1 (
    echo [ERROR] Cannot restore better-sqlite3.
    pause
    exit /b 1
  )
)

echo Step 4: Rebuilding server bundle...
call npm.cmd run build:server

echo Step 5: Reinstall auto-start scheduled task...
call "%~dp0server_autostart\install-autostart-task.bat"

echo.
echo Step 6: Start backend now...
call "%~dp0start-backend.bat"

echo.
echo ========================================
echo Done.
echo If still broken, see logs at:
echo   %ProgramData%\ShangpinCloudAssets\server-autostart.log
echo ========================================
pause
