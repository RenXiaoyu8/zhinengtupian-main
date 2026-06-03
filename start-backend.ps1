param(
  [switch]$Detached,
  [switch]$Watch,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

$Port = 43123
$Root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$AssetsRootName = -join ([char[]](0x5C1A, 0x54C1, 0x6613, 0x7AD9, 0x56FE, 0x7247))
$AppDataFolderName = -join ([char[]](0x7A0B, 0x5E8F, 0x56FE, 0x7247, 0x52FF, 0x52A8))
$AssetsRoot = Join-Path 'D:\' $AssetsRootName
$AppDataDir = Join-Path $AssetsRoot $AppDataFolderName
$StaticDir = Join-Path $Root 'dist'
$ServerBundle = Join-Path $Root 'electron\server-bundle.cjs'
$AppExe = $null

$releaseApp = Get-ChildItem -Path $Root -Filter '*.exe' -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -ne 'updater.exe' } |
  Select-Object -First 1
if ($releaseApp) {
  $AppExe = $releaseApp.FullName
  $StaticDir = Join-Path $Root 'resources\app.asar\dist'
  $externalServerBundle = Join-Path $Root 'electron\server-bundle.cjs'
  if (Test-Path $externalServerBundle) {
    $ServerBundle = $externalServerBundle
  } else {
    $ServerBundle = Join-Path $Root 'resources\app.asar\electron\server-bundle.cjs'
  }
}

$LogDir = Join-Path $env:ProgramData 'ShangpinCloudAssets'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir 'manual-backend.log'
$LaunchLogFile = Join-Path $LogDir 'backend-launch.log'
$DatabasePath = Join-Path $AppDataDir 'visualflow.db'

function Write-LaunchLog {
  param([string]$Message)
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" | Add-Content -Path $LaunchLogFile -Encoding UTF8
}

function Exit-WithMessage {
  param(
    [int]$Code,
    [string]$Message
  )
  if ($Message) {
    Write-Host $Message
  }
  if (-not $NoPause) {
    Read-Host 'Press Enter to close'
  }
  exit $Code
}

function Get-ListeningPortOwners {
  param([int]$ListenPort)
  $owners = New-Object System.Collections.Generic.HashSet[int]
  try {
    $pattern = "^\s*TCP\s+\S+:$ListenPort\s+\S+\s+(LISTENING|监听)\s+(\d+)\s*$"
    & netstat.exe -ano -p tcp 2>$null |
      ForEach-Object {
        if ($_ -match $pattern) {
          [void]$owners.Add([int]$Matches[2])
        }
      }
  } catch {}
  return @($owners)
}

function Test-PortListening {
  param([int]$ListenPort)
  return @((Get-ListeningPortOwners -ListenPort $ListenPort)).Count -gt 0
}

function Stop-ProcessTreeQuietly {
  param([int]$ProcessId)
  if ($ProcessId -le 4 -or $ProcessId -eq $PID) { return }
  try {
    & cmd.exe /c "taskkill /PID $ProcessId /T /F >nul 2>nul"
  } catch {}
}

Write-Host '========================================'
Write-Host '  Shangpin Cloud Assets - Backend'
Write-Host '========================================'
Write-Host "Root:          $Root"
Write-Host "StaticDir:     $StaticDir"
Write-Host "ServerBundle:  $ServerBundle"
Write-Host "AppExe:        $AppExe"
Write-Host "AssetsRoot:    $AssetsRoot"
Write-Host "DatabasePath:  $DatabasePath"
Write-Host "Port:          $Port"
Write-Host "Log:           $LogFile"
Write-Host '========================================'

if (-not $AppExe -and -not (Test-Path (Join-Path $StaticDir 'index.html'))) {
  Exit-WithMessage 1 '[ERROR] dist/index.html not found. Please build or publish first.'
}

if ($AppExe -and -not (Test-Path (Join-Path $Root 'resources\app.asar'))) {
  Exit-WithMessage 1 '[ERROR] resources/app.asar not found.'
}

if (-not (Test-Path $ServerBundle)) {
  Exit-WithMessage 1 '[ERROR] server-bundle.cjs not found.'
}

New-Item -ItemType Directory -Force -Path $AppDataDir | Out-Null

function Test-BetterSqlite3Binding {
  $bindingRoots = @(
    Join-Path $Root 'node_modules\better-sqlite3\build\Release\better_sqlite3.node'
    Join-Path $Root 'node_modules\better-sqlite3\build\Debug\better_sqlite3.node'
    Join-Path $Root 'node_modules\better-sqlite3\build\default\better_sqlite3.node'
    Join-Path $Root 'node_modules\better-sqlite3\compiled\24.14.0\win32\x64\better_sqlite3.node'
    Join-Path $Root 'node_modules\better-sqlite3\addon-build\release\install-root\better_sqlite3.node'
    Join-Path $Root 'node_modules\better-sqlite3\addon-build\debug\install-root\better_sqlite3.node'
    Join-Path $Root 'node_modules\better-sqlite3\addon-build\default\install-root\better_sqlite3.node'
    Join-Path $Root 'node_modules\better-sqlite3\lib\binding\node-v137-win32-x64\better_sqlite3.node'
  )
  foreach ($path in $bindingRoots) {
    if (Test-Path $path) {
      return $true
    }
  }
  return $false
}

try {
  $selfPid = $PID
  $oldWatchers = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProcessId -ne $selfPid -and
      $_.CommandLine -match 'start-backend\.ps1' -and
      $_.CommandLine -match '\-Watch'
    } |
    Select-Object -ExpandProperty ProcessId -Unique
  foreach ($processId in $oldWatchers) {
    Write-Host "Stopping old backend watcher PID $processId"
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }

  $listenPorts = @($Port)
  if ($Port -ne 3000) { $listenPorts += 3000 }
  $listeners = @()
  foreach ($listenPort in $listenPorts) {
    $listeners += Get-ListeningPortOwners -ListenPort $listenPort
  }
  $listeners = $listeners | Select-Object -Unique
  foreach ($processId in $listeners) {
    if ([int]$processId -le 4) { continue }
    Write-Host "Stopping old backend PID $processId"
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$processId)" -ErrorAction SilentlyContinue
    if ($proc -and [int]$proc.ParentProcessId -gt 4) {
      $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$proc.ParentProcessId)" -ErrorAction SilentlyContinue
      if ($parent -and ([string]$parent.Name).ToLowerInvariant() -eq 'powershell.exe') {
        Stop-ProcessTreeQuietly -ProcessId ([int]$parent.ProcessId)
      }
    }
    Stop-ProcessTreeQuietly -ProcessId ([int]$processId)
  }
} catch {
  Write-Host "Port cleanup skipped: $($_.Exception.Message)"
}
Start-Sleep -Seconds 1

if ($ServerBundle -and (Test-Path $ServerBundle)) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Exit-WithMessage 1 '[ERROR] node.exe not found. Please install Node.js 20+.'
  }
  $needsNativeRebuild = $env:REBUILD_NATIVE_DEPS -eq '1' -or -not (Test-BetterSqlite3Binding)
  if ($needsNativeRebuild -and (Test-Path (Join-Path $Root 'package.json'))) {
    Write-Host 'Rebuilding better-sqlite3 for current Node runtime...'
    Push-Location $Root
    try {
      & npm.cmd rebuild better-sqlite3
    } catch {
      Write-Host "npm rebuild skipped/failed: $($_.Exception.Message)"
    } finally {
      Pop-Location
    }
  }
}

if ($Detached) {
  Write-Host 'Starting backend in background...'
  Write-LaunchLog "Detached start requested. Root=$Root StaticDir=$StaticDir ServerBundle=$ServerBundle AppExe=$AppExe"
  if ($ServerBundle -and (Test-Path $ServerBundle)) {
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Watch', '-NoPause')
    $child = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WorkingDirectory $Root -WindowStyle Hidden -PassThru
    Write-LaunchLog "Started powershell backend PID=$($child.Id)"
  } else {
    $child = Start-Process -FilePath $AppExe -ArgumentList '--server-only' -WorkingDirectory $Root -WindowStyle Hidden -PassThru
    Write-LaunchLog "Started app backend PID=$($child.Id)"
  }
  for ($i = 1; $i -le 60; $i++) {
    Start-Sleep -Seconds 1
    if (Test-PortListening -ListenPort $Port) {
      Write-Host "[OK] Backend is listening on port $Port."
      Write-LaunchLog "Backend is listening on port $Port."
      exit 0
    }
    if ($child -and $child.HasExited) {
      Write-Host "[WARN] Backend process exited before port $Port became ready. Exit code: $($child.ExitCode)"
      Write-LaunchLog "Backend process exited early. ExitCode=$($child.ExitCode)"
      if (Test-Path $LogFile) {
        Write-Host "Log: $LogFile"
        Get-Content $LogFile -Tail 80
      }
      exit 3
    }
  }
  Write-Host "[WARN] Backend was started, but port $Port is not listening yet."
  Write-Host "Log: $LogFile"
  Write-LaunchLog "Backend readiness timed out after 60 seconds."
  if (Test-Path $LogFile) {
    Get-Content $LogFile -Tail 80
  }
  exit 2
}

$env:PORT = [string]$Port
$env:NODE_ENV = 'production'
$env:STATIC_DIR = $StaticDir
$env:ASSETS_ROOT = $AssetsRoot
$env:DATABASE_PATH = $DatabasePath

"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting backend from $Root" | Set-Content -Path $LogFile -Encoding UTF8
if ($AppExe) {
  "AppExe=$AppExe --server-only" | Add-Content -Path $LogFile -Encoding UTF8
}
if ($ServerBundle -and (Test-Path $ServerBundle)) {
  (& node -v) | Add-Content -Path $LogFile -Encoding UTF8
}

Write-Host 'Starting backend. Keep this window open while the backend is running.'
Write-Host ''
$ErrorActionPreference = 'Continue'
if ($Watch) {
  $restart = 0
  while ($true) {
    $restart += 1
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Watch start #$restart" | Add-Content -Path $LogFile -Encoding UTF8
    if ($ServerBundle -and (Test-Path $ServerBundle)) {
      & node $ServerBundle *>> $LogFile
    } else {
      & $AppExe --server-only *>> $LogFile
    }
    $exitCode = $LASTEXITCODE
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Backend exited with code $exitCode; restarting in 5 seconds." | Add-Content -Path $LogFile -Encoding UTF8
    Start-Sleep -Seconds 5
  }
}

if ($ServerBundle -and (Test-Path $ServerBundle)) {
  & node $ServerBundle *>> $LogFile
} else {
  & $AppExe --server-only *>> $LogFile
}
$exitCode = $LASTEXITCODE

Write-Host ''
Write-Host "[ERROR] Backend exited with code $exitCode"
Write-Host "Log: $LogFile"
Get-Content $LogFile -Tail 80
if (-not $NoPause) {
  Read-Host 'Press Enter to close'
}
exit $exitCode
