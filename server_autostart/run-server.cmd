@echo off
setlocal
chcp 65001 >nul

REM Always run from this script directory
pushd "%~dp0"

REM ---- Config ----
set "PORT=43123"
set "LEGACY_PORT=3000"
set "ASSETS_ROOT=D:\尚品易站图片"
set "NODE_ENV=production"

REM Project root = parent folder of server_autostart
for %%I in ("%~dp0..") do set "PROJ_ROOT=%%~fI"
set "STATIC_DIR=%PROJ_ROOT%\dist"
set "DATABASE_PATH=%PROJ_ROOT%\visualflow.db"
set "LOG_DIR=%ProgramData%\ShangpinCloudAssets"
set "LOG_FILE=%LOG_DIR%\server-autostart.log"

mkdir "%LOG_DIR%" >nul 2>&1
if not exist "%LOG_DIR%\" (
  REM Fallback: project logs folder
  set "LOG_DIR=%PROJ_ROOT%\logs"
  set "LOG_FILE=%LOG_DIR%\server-autostart.log"
  mkdir "%LOG_DIR%" >nul 2>&1
)
if not exist "%LOG_DIR%\" (
  REM Last fallback: temp
  set "LOG_DIR=%TEMP%\shangpin-cloud-assets"
  set "LOG_FILE=%LOG_DIR%\server-autostart.log"
  mkdir "%LOG_DIR%" >nul 2>&1
)

REM Locate node.exe (SYSTEM may not have PATH)
set "NODE_EXE="
if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if "%NODE_EXE%"=="" (
  for /f "delims=" %%N in ('where node 2^>nul') do (
    set "NODE_EXE=%%N"
    goto :node_found
  )
)
:node_found

echo ==================================================>> "%LOG_FILE%"
echo [%date% %time%] Starting server...>> "%LOG_FILE%"
echo PROJ_ROOT=%PROJ_ROOT%>> "%LOG_FILE%"
echo STATIC_DIR=%STATIC_DIR%>> "%LOG_FILE%"
echo ASSETS_ROOT=%ASSETS_ROOT%>> "%LOG_FILE%"
echo DATABASE_PATH=%DATABASE_PATH%>> "%LOG_FILE%"
echo PORT=%PORT%>> "%LOG_FILE%"
echo LEGACY_PORT=%LEGACY_PORT%>> "%LOG_FILE%"
echo NODE_EXE=%NODE_EXE%>> "%LOG_FILE%"
echo LOG_FILE=%LOG_FILE%>> "%LOG_FILE%"

if "%NODE_EXE%"=="" (
  echo [%date% %time%] [ERROR] node.exe not found. Please install Node.js to C:\Program Files\nodejs\>> "%LOG_FILE%"
  popd
  exit /b 1
)

if not exist "%STATIC_DIR%\index.html" (
  echo [%date% %time%] [ERROR] dist not found. Run: npm run build>> "%LOG_FILE%"
  popd
  exit /b 1
)

REM Free port if occupied (best effort)
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":%PORT% " ^| findstr /C:"LISTENING" /C:"监听"') do (
  echo [%date% %time%] Killing PID %%a on port %PORT%>> "%LOG_FILE%"
  taskkill /PID %%a /F >> "%LOG_FILE%" 2>&1
)

REM Use bundled server for stable runtime
set "PORT=%PORT%"
set "ASSETS_ROOT=%ASSETS_ROOT%"
set "STATIC_DIR=%STATIC_DIR%"
set "DATABASE_PATH=%DATABASE_PATH%"
set "NODE_ENV=%NODE_ENV%"

REM 循环：进程退出后等待几秒再重启，避免“运行一会就断”后不再恢复（最多 5 分钟内重启 10 次，防止死循环）
set "RESTART_DELAY=5"
set "RESTART_COUNT=0"
set "RESTART_MAX=10"
set "RESTART_RESET_TIME=300"

:run_server
set /a RESTART_COUNT+=1
echo [%date% %time%] Running: "%NODE_EXE%" "%PROJ_ROOT%\electron\server-bundle.cjs" (restart #%RESTART_COUNT%)>> "%LOG_FILE%"
"%NODE_EXE%" "%PROJ_ROOT%\electron\server-bundle.cjs" >> "%LOG_FILE%" 2>&1
set "EXIT_CODE=%errorlevel%"
echo [%date% %time%] Server process exited (code %EXIT_CODE%).>> "%LOG_FILE%"

if %RESTART_COUNT% geq %RESTART_MAX% (
  echo [%date% %time%] Too many restarts, stopping.>> "%LOG_FILE%"
  popd
  exit /b %EXIT_CODE%
)
echo [%date% %time%] Restarting in %RESTART_DELAY% seconds...>> "%LOG_FILE%"
timeout /t %RESTART_DELAY% /nobreak >nul
goto run_server
