# Extract winCodeSign 7z to electron-builder cache (run after download-wincodesign.ps1)
$cacheDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
$archive = "$cacheDir\winCodeSign-2.6.0.7z"

if (!(Test-Path $archive)) {
    Write-Host "Error: $archive not found. Run download-wincodesign.ps1 first."
    exit 1
}

$7zPath = "C:\Program Files\7-Zip\7z.exe"
if (!(Test-Path $7zPath)) {
    Write-Host "7-Zip not found. Please install from https://www.7-zip.org/ or extract manually:"
    Write-Host "  1. Open $archive with 7-Zip"
    Write-Host "  2. Extract to $cacheDir"
    exit 1
}

Write-Host "Extracting to $cacheDir ..."
& $7zPath x $archive "-o$cacheDir" -y
if ($LASTEXITCODE -eq 0) {
    Write-Host "Done. You can now run the build."
} else {
    Write-Host "Extract failed. Try: right-click 7z -> Extract to..."
}
