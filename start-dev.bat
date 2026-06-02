@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

chcp 65001 >nul

if not exist "package.json" (
  echo [Error] package.json not found.
  pause
  exit /b 1
)

for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":43123 " ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>&1
timeout /t 2 /nobreak >nul

if not exist "dist\index.html" (
  echo Building frontend...
  call npm run build
  if errorlevel 1 ( echo Build failed. & pause & exit /b 1 )
) else (
  echo dist already exists, skip frontend build.
)

if not exist "electron\server-bundle.cjs" (
  echo Building server bundle...
  call npm run build:server
  if errorlevel 1 ( echo build:server failed. & pause & exit /b 1 )
) else (
  echo server-bundle.cjs exists, skip server build.
)

echo Rebuilding native modules for Electron...
if not exist "node_modules\.bin\electron-builder.cmd" (
  echo [Error] electron-builder not installed. Run: npm install
  call npm install
  if errorlevel 1 ( pause & exit /b 1 )
)
call "node_modules\.bin\electron-builder.cmd" install-app-deps
if errorlevel 1 ( echo install-app-deps failed. Run as Administrator. & pause & exit /b 1 )

call npm run electron:dev
echo.
pause
