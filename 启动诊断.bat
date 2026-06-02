@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM Use writable directory for logs
if not exist "%LOCALAPPDATA%\shangpin-cloud-assets" mkdir "%LOCALAPPDATA%\shangpin-cloud-assets"
set "LOG_FILE=%LOCALAPPDATA%\shangpin-cloud-assets\startup.log"
set "EXE_PATH=%~dp0尚品易站云资产.exe"

if not exist "%EXE_PATH%" (
  echo ERROR: Cannot find "尚品易站云资产.exe"
  echo Place this .bat in the same folder as the .exe
  pause
  exit /b 1
)

echo ========================================
echo   Shangpin Cloud Assets - Startup Diagnose
echo ========================================
echo.
echo Log file: %LOG_FILE%
echo.

REM Create log entry even if app fails to start
echo [%date% %time%] === Diagnose script started === >> "%LOG_FILE%"
echo [%date% %time%] Launching: %EXE_PATH% >> "%LOG_FILE%"

echo Launching app...
echo ========================================

"%EXE_PATH%" 2>&1
set EXIT_CODE=%ERRORLEVEL%

echo [%date% %time%] App exited. Exit code: %EXIT_CODE% >> "%LOG_FILE%"

echo.
echo ----------------------------------------
echo App exited. Exit code: %EXIT_CODE%
echo.
echo Startup log file (send its content to developer):
echo   %LOG_FILE%
echo.
echo Press any key to open log folder...
pause >nul
explorer "%LOCALAPPDATA%\shangpin-cloud-assets"
