param(
  [string]$Root = (Get-Location).Path
)

$ErrorActionPreference = 'SilentlyContinue'

try {
  $Root = (Resolve-Path $Root).Path.TrimEnd('\')
} catch {}

Write-Host 'Stopping scheduled backend task...'
& schtasks /End /TN "ShangpinCloudAssets-Server" *> $null

function Stop-ProcessTree {
  param([int]$ProcessId)
  if ($ProcessId -le 4 -or $ProcessId -eq $PID) { return }
  try {
    & taskkill.exe /PID $ProcessId /T /F *> $null
  } catch {}
}

function Get-ListeningPortOwners {
  param([int]$Port)
  $owners = New-Object System.Collections.Generic.HashSet[int]
  try {
    $pattern = "^\s*TCP\s+\S+:$Port\s+\S+\s+(LISTENING|监听)\s+(\d+)\s*$"
    & netstat.exe -ano -p tcp 2>$null |
      ForEach-Object {
        if ($_ -match $pattern) {
          [void]$owners.Add([int]$Matches[2])
        }
      }
  } catch {}
  return @($owners)
}

Write-Host 'Stopping backend ports...'
foreach ($port in @(43123, 3000)) {
  Write-Host "  port $port"
  foreach ($owner in (Get-ListeningPortOwners -Port $port)) {
    Stop-ProcessTree -ProcessId ([int]$owner)
  }
}

Write-Host 'Stopping Shangpin app processes...'
Get-Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Id -ne $PID -and (
      $_.ProcessName -like '*Shangpin*' -or
      $_.ProcessName -like '*CloudAssets*'
    )
  } |
  ForEach-Object { Stop-ProcessTree -ProcessId $_.Id }

Write-Host 'Stopping workspace helper processes...'
$nameFilter = "Name = 'node.exe' OR Name = 'electron.exe' OR Name = 'tsx.exe'"
$rootPattern = [regex]::Escape($Root)
Get-CimInstance Win32_Process -Filter $nameFilter -ErrorAction SilentlyContinue |
  Where-Object {
    $_.ProcessId -ne $PID -and
    (
      ($_.CommandLine -match $rootPattern) -or
      ($_.CommandLine -match 'server-bundle\.cjs') -or
      ($_.CommandLine -match 'start-backend\.ps1') -or
      ($_.CommandLine -match 'ShangpinCloudAssets')
    )
  } |
  ForEach-Object { Stop-ProcessTree -ProcessId ([int]$_.ProcessId) }

Write-Host 'Close step complete.'
exit 0
