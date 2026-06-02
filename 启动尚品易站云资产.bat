@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

call "%~dp0start-dev.bat"
echo.
pause
exit /b 0
