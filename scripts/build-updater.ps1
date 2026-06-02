$ErrorActionPreference = 'Stop'

function Get-PythonCommand {
  if (Get-Command python -ErrorAction SilentlyContinue) {
    return @((Get-Command python).Source)
  }
  if (Get-Command py -ErrorAction SilentlyContinue) {
    return @((Get-Command py).Source, '-3')
  }
  throw 'Python 3 not found.'
}

function Invoke-PythonCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$PythonCmd,
    [Parameter(Mandatory = $true)]
    [string[]]$PythonArgs
  )

  $exe = $PythonCmd[0]
  $prefix = @()
  if ($PythonCmd.Length -gt 1) {
    $prefix = $PythonCmd[1..($PythonCmd.Length - 1)]
  }
  & $exe @($prefix + $PythonArgs) | Out-Host
  return [int]$LASTEXITCODE
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$specPath = Join-Path $projectRoot 'updater.spec'
$distExe = Join-Path $projectRoot 'dist\updater.exe'
$distDirExe = Join-Path $projectRoot 'dist\updater\updater.exe'
$buildDir = Join-Path $projectRoot 'build'
$targetExe = Join-Path $buildDir 'updater.exe'

if (!(Test-Path $specPath)) {
  throw "updater.spec not found: $specPath"
}

if (!(Test-Path $buildDir)) {
  New-Item -ItemType Directory -Path $buildDir | Out-Null
}

$pythonCmd = Get-PythonCommand
Write-Host 'Building updater.exe...'
$buildCode = Invoke-PythonCommand -PythonCmd $pythonCmd -PythonArgs @('-m', 'PyInstaller', '--noconfirm', $specPath)
if ($buildCode -ne 0) {
  Write-Host 'Initial build failed. Installing or repairing PyInstaller...'
  $installCode = Invoke-PythonCommand -PythonCmd $pythonCmd -PythonArgs @('-m', 'pip', 'install', 'pyinstaller')
  if ($installCode -ne 0) {
    throw 'Failed to install PyInstaller.'
  }
  $buildCode = Invoke-PythonCommand -PythonCmd $pythonCmd -PythonArgs @('-m', 'PyInstaller', '--noconfirm', $specPath)
  if ($buildCode -ne 0) {
    throw 'PyInstaller build failed.'
  }
}

$builtExe = $null
if (Test-Path $distExe) {
  $builtExe = $distExe
} elseif (Test-Path $distDirExe) {
  $builtExe = $distDirExe
}

if (-not $builtExe) {
  throw 'updater.exe was not generated.'
}

Copy-Item -Path $builtExe -Destination $targetExe -Force
Write-Host "Generated: $targetExe"
