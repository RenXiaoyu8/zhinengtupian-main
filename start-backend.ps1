param(
  [switch]$Detached,
  [switch]$Watch,
  [switch]$EnsureRunning,
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
  # Plain Node serves the external dist folder. Only Electron can read inside app.asar.
  if (-not (Test-Path (Join-Path $StaticDir 'index.html'))) {
    $StaticDir = Join-Path $Root 'resources\app.asar\dist'
  }
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

function Stop-ProcessTreeQuietly {
  param([int]$ProcessId)
  if ($ProcessId -le 4 -or $ProcessId -eq $PID) { return }
  try {
    & taskkill.exe /PID $ProcessId /T /F *> $null
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

function Test-BackendReady {
  try {
    $api = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/config" -TimeoutSec 3
    return $api.port -eq $Port -and ($null -ne $api.PSObject.Properties['lanBaseUrl'])
  } catch { return $false }
}

$useNode = (Test-Path -LiteralPath $ServerBundle) -and (Test-Path -LiteralPath (Join-Path $StaticDir 'index.html'))
if ($EnsureRunning -and (Test-BackendReady)) { exit 0 }
if ($useNode) {
  Push-Location $Root
  try {
    $check = "new (require('better-sqlite3'))(':memory:').close()"
    & node -e $check
    if ($LASTEXITCODE -ne 0 -or $env:REBUILD_NATIVE_DEPS -eq '1') {
      & npm.cmd rebuild better-sqlite3
      if ($LASTEXITCODE -ne 0) { Exit-WithMessage 1 'Cannot rebuild the SQLite binding for Node.' }
      & node -e $check
      if ($LASTEXITCODE -ne 0) { Exit-WithMessage 1 'Cannot open an in-memory SQLite database.' }
    }
  } finally { Pop-Location }
} elseif (-not $AppExe) { Exit-WithMessage 1 'No usable backend runtime found.' }

if (-not $Watch) {
  $watchers = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and
      $_.CommandLine.IndexOf($PSCommandPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $_.CommandLine -match '\s-Watch\b' })
  if ($EnsureRunning -and $watchers.Count) {
    for ($i = 0; $i -lt 10; $i++) {
      if (Test-BackendReady) { exit 0 }
      Start-Sleep -Seconds 1
    }
    Exit-WithMessage 1 'Current backend watcher is running but the API is unavailable.'
  }
  foreach ($watcher in $watchers) { Stop-ProcessTreeQuietly -ProcessId $watcher.ProcessId }
  foreach ($listenerId in (Get-ListeningPortOwners -ListenPort $Port)) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $listenerId" -ErrorAction SilentlyContinue
    $isOurNode = $proc.CommandLine -and $proc.CommandLine.IndexOf($ServerBundle, [StringComparison]::OrdinalIgnoreCase) -ge 0
    $isOurApp = $AppExe -and $proc.ExecutablePath -eq $AppExe -and $proc.CommandLine -match '--server-only'
    if ($EnsureRunning -or (-not $isOurNode -and -not $isOurApp)) {
      Exit-WithMessage 1 "Port $Port is already occupied. Leaving its owner running."
    }
    Stop-ProcessTreeQuietly -ProcessId $listenerId
  }
}

if ($Detached) {
  Write-Host 'Starting backend in background...'
  Write-LaunchLog "Detached start requested. Root=$Root StaticDir=$StaticDir ServerBundle=$ServerBundle AppExe=$AppExe"
  if ($useNode) {
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-Watch', '-NoPause')
    $child = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WorkingDirectory $Root -WindowStyle Hidden -PassThru
    Write-LaunchLog "Started powershell backend PID=$($child.Id)"
  } else {
    $child = Start-Process -FilePath $AppExe -ArgumentList '--server-only' -WorkingDirectory $Root -WindowStyle Hidden -PassThru
    Write-LaunchLog "Started app backend PID=$($child.Id)"
  }
  for ($i = 1; $i -le 60; $i++) {
    Start-Sleep -Seconds 1
    if (Test-BackendReady) {
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
if ($useNode) {
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
    if ($useNode) {
      & node $ServerBundle *>> $LogFile
    } else {
      & $AppExe --server-only *>> $LogFile
    }
    $exitCode = $LASTEXITCODE
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Backend exited with code $exitCode; restarting in 5 seconds." | Add-Content -Path $LogFile -Encoding UTF8
    Start-Sleep -Seconds 5
  }
}

if ($useNode) {
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
