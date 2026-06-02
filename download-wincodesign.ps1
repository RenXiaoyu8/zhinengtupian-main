# Run with VPN on. Saves winCodeSign to electron-builder cache.
$url = "https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z"
$cacheDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
$outFile = "$cacheDir\winCodeSign-2.6.0.7z"

Write-Host "Downloading winCodeSign (need VPN if GitHub blocked)..."
if (!(Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing
Write-Host "Done. File saved to: $outFile"
Write-Host "Note: electron-builder may expect a different path. If build still fails, try signAndEditExecutable: false in package.json"
