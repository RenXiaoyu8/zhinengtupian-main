$ErrorActionPreference = 'Stop'

param(
  [string]$Version,
  [string]$ReleaseNotes
)

function Update-JsonFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Mutator
  )

  $json = Get-Content -Path $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  & $Mutator $json
  $content = $json | ConvertTo-Json -Depth 100
  Set-Content -Path $Path -Value $content -Encoding UTF8
}

function Find-AppExe {
  param([Parameter(Mandatory = $true)][string]$ReleaseRoot)

  $exe = Get-ChildItem -Path $ReleaseRoot -Recurse -Filter '*.exe' -File |
    Where-Object {
      $_.Name -ne 'updater.exe' -and
      $_.FullName -notmatch '\\resources\\' -and
      $_.FullName -notmatch '\\squirrel\\.exe$'
    } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $exe) {
    throw "No client exe found under $ReleaseRoot."
  }
  return $exe
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$packageJson = Join-Path $projectRoot 'package.json'
$updateConfig = Join-Path $projectRoot 'update_config.json'
$releaseRoot = Join-Path $projectRoot 'release'
$releasesDir = Join-Path $projectRoot 'releases'
$buildUpdaterScript = Join-Path $PSScriptRoot 'build-updater.ps1'
$npmCmd = if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { 'npm.cmd' } else { 'npm' }

if (!(Test-Path $packageJson)) { throw "package.json not found: $packageJson" }
if (!(Test-Path $updateConfig)) { throw "update_config.json not found: $updateConfig" }
if (!(Test-Path $buildUpdaterScript)) { throw "build-updater.ps1 not found: $buildUpdaterScript" }

$pkg = Get-Content -Path $packageJson -Raw -Encoding UTF8 | ConvertFrom-Json
$currentVersion = [string]$pkg.version

if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = Read-Host "Input new version (current: $currentVersion)"
}
if ([string]::IsNullOrWhiteSpace($Version)) {
  throw 'Version is required.'
}

if ([string]::IsNullOrWhiteSpace($ReleaseNotes)) {
  $ReleaseNotes = Read-Host 'Input release notes'
}
if ([string]::IsNullOrWhiteSpace($ReleaseNotes)) {
  $ReleaseNotes = "Updated to version $Version: fixes and improvements."
}

$zipName = "shangpin-cloud-assets-$Version.zip"
$zipPath = Join-Path $releasesDir $zipName

if (!(Test-Path $releasesDir)) {
  New-Item -ItemType Directory -Path $releasesDir | Out-Null
}

Write-Host 'Updating package.json version...'
Update-JsonFile -Path $packageJson -Mutator {
  param($json)
  $json.version = $Version
}

Write-Host 'Running electron build...'
& $npmCmd 'run' 'electron:build'
if ($LASTEXITCODE -ne 0) {
  throw 'electron:build failed.'
}

$appExe = Find-AppExe -ReleaseRoot $releaseRoot
$appDir = Split-Path -Parent $appExe.FullName

Write-Host "Detected app dir: $appDir"
if (Test-Path $zipPath) {
  Remove-Item -Path $zipPath -Force
}

Write-Host "Compressing app dir to: $zipPath"
Compress-Archive -Path $appDir -DestinationPath $zipPath -Force

Write-Host 'Updating update_config.json...'
Update-JsonFile -Path $updateConfig -Mutator {
  param($json)
  $json.version = $Version
  $json.fileName = $zipName
  $json.releaseNotes = $ReleaseNotes
}

$cfg = Get-Content -Path $updateConfig -Raw -Encoding UTF8 | ConvertFrom-Json
$downloadUrl = if ($cfg.publicBaseUrl) {
  ($cfg.publicBaseUrl.TrimEnd('/')) + '/releases/' + [Uri]::EscapeDataString($zipName)
} else {
  ''
}

Write-Host ''
Write-Host 'Publish complete.'
Write-Host "Version: $Version"
Write-Host "Package: $zipPath"
if ($downloadUrl) {
  Write-Host "Download URL: $downloadUrl"
} else {
  Write-Host 'Note: publicBaseUrl is empty. Please verify clients can access /releases manually.'
}
