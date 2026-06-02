$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir '..'))
$Launcher = Join-Path $ProjectRoot 'start-backend.ps1'
$LogDir = Join-Path $env:ProgramData 'ShangpinCloudAssets'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir 'server-autostart.log'

function Write-Log {
  param([string]$Message)
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $LogFile -Value "[$timestamp] $Message" -Encoding UTF8
}

Write-Log '=================================================='
Write-Log 'System autostart delegating to unified backend launcher.'
Write-Log "ProjectRoot=$ProjectRoot"
Write-Log "Launcher=$Launcher"

if (-not (Test-Path $Launcher)) {
  Write-Log "[ERROR] Missing launcher: $Launcher"
  exit 1
}

Push-Location $ProjectRoot
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Launcher -Detached -NoPause
  $exitCode = $LASTEXITCODE
  Write-Log "Unified launcher exited with code $exitCode"
  exit $exitCode
} finally {
  Pop-Location
}
