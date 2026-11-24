@echo off
echo ========================================
echo   Rebuild Native Modules for Windows
echo ========================================
echo.
echo This script will rebuild canvas, better-sqlite3, and ffmpeg-static
echo to ensure Windows native binaries are installed.
echo.

cd /d "%~dp0"

echo Step 1: Clean existing native modules...
if exist "node_modules\canvas" rmdir /s /q "node_modules\canvas"
if exist "node_modules\better-sqlite3\build" rmdir /s /q "node_modules\better-sqlite3\build"
if exist "node_modules\ffmpeg-static" rmdir /s /q "node_modules\ffmpeg-static"

echo.
echo Step 2: Reinstall canvas...
call npm install canvas
if %errorlevel% neq 0 (
  echo [ERROR] canvas installation failed
  pause
  exit /b 1
)

echo.
echo Step 3: Reinstall better-sqlite3...
call npm install better-sqlite3
if %errorlevel% neq 0 (
  echo [ERROR] better-sqlite3 installation failed
  pause
  exit /b 1
)

echo.
echo Step 4: Reinstall ffmpeg-static...
call npm install ffmpeg-static
if %errorlevel% neq 0 (
  echo [ERROR] ffmpeg-static installation failed
  pause
  exit /b 1
)

echo.
echo ========================================
echo   Verification
echo ========================================
echo.

set "ALL_OK=1"

if exist "node_modules\canvas\build\Release\canvas.node" (
  echo [OK] canvas.node found
) else (
  echo [FAIL] canvas.node NOT found
  set "ALL_OK=0"
)

if exist "node_modules\better-sqlite3\build\Release\better_sqlite3.node" (
  echo [OK] better_sqlite3.node found
) else (
  echo [FAIL] better_sqlite3.node NOT found
  set "ALL_OK=0"
)

if exist "node_modules\ffmpeg-static\ffmpeg.exe" (
  echo [OK] ffmpeg.exe found
) else (
  echo [FAIL] ffmpeg.exe NOT found - checking for ffmpeg without .exe...
  if exist "node_modules\ffmpeg-static\ffmpeg" (
    echo [WARN] Found 'ffmpeg' without .exe extension - this is likely Linux version!
    echo Please delete node_modules\ffmpeg-static and reinstall on Windows.
  )
  set "ALL_OK=0"
)

echo.
if "%ALL_OK%"=="1" (
  echo [SUCCESS] All native modules are ready for Windows!
  echo You can now run the release launcher in the project folder.
) else (
  echo [ERROR] Some native modules are missing or incorrect.
  echo Please check the errors above.
)
echo.
pause
