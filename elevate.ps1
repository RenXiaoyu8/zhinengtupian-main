# Run run-dev.cmd as Administrator, using this script's own directory.
$dir = $PSScriptRoot
if (-not $dir) {
  $dir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$cmdPath = Join-Path $dir "run-dev.cmd"
if (-not (Test-Path -LiteralPath $cmdPath)) {
  throw "Not found: $cmdPath"
}
Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "`"$cmdPath`"" -Verb RunAs
