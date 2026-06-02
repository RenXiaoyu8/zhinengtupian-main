@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul

echo ========================================
echo   Fix Backend and Restore Auto-Start
echo ========================================
echo This rebuilds native modules and the server bundle,
echo then reinstalls the Windows scheduled task for auto-start.
echo.

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath cmd.exe -ArgumentList '/k','\"\"%~f0\"\"' -Verb RunAs"
  exit /b
)

echo Step 1: Closing running processes...
taskkill /F /IM "electron.exe" >nul 2>&1
taskkill /F /IM "node.exe" >nul 2>&1
taskkill /F /IM "tsx.exe" >nul 2>&1
timeout /t 2 /nobreak >nul

echo.
echo Step 2: Cleaning better-sqlite3 native build...
if exist "node_modules\better-sqlite3\build\Release\better_sqlite3.node" (
  attrib -R "node_modules\better-sqlite3\build\Release\better_sqlite3.node" >nul 2>&1
  del /f /q "node_modules\better-sqlite3\build\Release\better_sqlite3.node" >nul 2>&1
)
if exist "node_modules\better-sqlite3\build" rmdir /s /q "node_modules\better-sqlite3\build" >nul 2>&1

echo.
echo Step 3: Rebuilding native module for system Node...
call npm.cmd rebuild better-sqlite3
if errorlevel 1 (
  echo [WARN] npm rebuild failed, trying install...
  call npm.cmd install better-sqlite3@12.6.2 --no-save
  if errorlevel 1 (
    echo [ERROR] Cannot restore better-sqlite3.
    pause
    exit /b 1
  )
)

echo.
echo Step 4: Rebuilding server bundle...
call npm.cmd run build:server
if errorlevel 1 (
  echo [WARN] server bundle build failed.
)

echo.
echo Step 5: Reinstalling auto-start scheduled task...
call "%~dp0server_autostart\install-autostart-task.bat"
if errorlevel 1 (
  echo [WARN] Auto-start install returned error, but may still work.
)

echo.
echo Step 6: Starting backend immediately...
call "%~dp0start-backend.bat"

echo.
echo ========================================
echo All done. The backend should now be running and auto-start on boot.
echo If still broken, see logs:
echo   %ProgramData%\ShangpinCloudAssets\server-autostart.log
echo ========================================
pause
