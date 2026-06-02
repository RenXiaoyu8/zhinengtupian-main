param(
  [switch]$SkipGithubRelease
)

$ErrorActionPreference = 'Stop'

function Fail-WithHelp {
  param([string]$Message)
  Write-Host ""
  Write-Host "[ERROR] $Message" -ForegroundColor Red
  Write-Host ""
  Write-Host "First-time GitHub setup:"
  Write-Host "  git init"
  Write-Host "  git branch -M main"
  Write-Host "  git add ."
  Write-Host "  git commit -m `"Initial backup`""
  Write-Host "  git remote add origin https://github.com/YOUR_NAME/YOUR_REPO.git"
  Write-Host "  git push -u origin main"
  Write-Host ""
  exit 1
}

function Run-Git {
  param([string[]]$GitArgs)
  & git @GitArgs
  if ($LASTEXITCODE -ne 0) {
    throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Add-ExistingPath {
  param(
    [System.Collections.Generic.List[string]]$List,
    [string]$Path
  )
  if (Test-Path $Path) {
    $List.Add($Path) | Out-Null
  }
}

function Add-ExistingGlob {
  param(
    [System.Collections.Generic.List[string]]$List,
    [string]$Pattern
  )
  Get-ChildItem -Path $Pattern -File -ErrorAction SilentlyContinue | ForEach-Object {
    $List.Add($_.FullName) | Out-Null
  }
}

function Remove-TrackedIgnoredPath {
  param([string]$Path)
  $tracked = (& git ls-files -- "$Path")
  if ($tracked) {
    Write-Host "Removing runtime/generated files from Git index: $Path"
    Run-Git @("rm", "--cached", "-r", "--ignore-unmatch", "--", $Path)
  }
}

try {
  git --version | Out-Null
} catch {
  Fail-WithHelp "Git is not installed or not available in PATH."
}

if (-not (Test-Path ".git")) {
  Fail-WithHelp "This folder is not a Git repository yet."
}

$origin = (& git remote get-url origin 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $origin) {
  Fail-WithHelp "Git remote 'origin' is not configured."
}

if (-not (Test-Path "package.json")) {
  throw "package.json not found."
}

$pkg = Get-Content "package.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$pkg.version
if (-not $version) {
  throw "package.json version is empty."
}

$tag = "v$version"
$branch = (& git branch --show-current).Trim()
if (-not $branch) {
  $branch = "main"
}

Write-Host "========================================"
Write-Host "  GitHub Backup"
Write-Host "========================================"
Write-Host "Version: $version"
Write-Host "Tag:     $tag"
Write-Host "Branch:  $branch"
Write-Host "Remote:  $origin"
Write-Host "========================================"

Write-Host "Preparing important-source-only backup..."
Write-Host "Excluded: uploads, node_modules, build/dist/release output, release zip files, logs, databases."

Remove-TrackedIgnoredPath "uploads"
Remove-TrackedIgnoredPath "node_modules"
Remove-TrackedIgnoredPath "build"
Remove-TrackedIgnoredPath "dist"
Remove-TrackedIgnoredPath "release"
Remove-TrackedIgnoredPath "releases"
Remove-TrackedIgnoredPath "tmp-asar"

$pathsToAdd = [System.Collections.Generic.List[string]]::new()

foreach ($path in @(
  ".gitignore",
  "package.json",
  "package-lock.json",
  "index.html",
  "tsconfig.json",
  "vite.config.ts",
  "server.ts",
  "updater.py",
  "init_assets.ts",
  "metadata.json",
  "server_config.example.json",
  "update_config.example.json",
  ".env.example",
  "src",
  "electron",
  "scripts",
  "server_autostart",
  "user-manager"
)) {
  Add-ExistingPath $pathsToAdd $path
}

foreach ($pattern in @("*.bat", "*.cmd", "*.ps1", "*.md", "*.txt", "*.svg")) {
  Add-ExistingGlob $pathsToAdd $pattern
}

if ($pathsToAdd.Count -eq 0) {
  throw "No important source paths found to add."
}

$gitAddArgs = @("add", "--") + $pathsToAdd.ToArray()
Run-Git $gitAddArgs

$largeTrackedFiles = Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Length -gt 100MB -and
    $_.FullName -notmatch '\\\.git\\' -and
    $_.FullName -notmatch '\\node_modules\\' -and
    $_.FullName -notmatch '\\uploads\\' -and
    $_.FullName -notmatch '\\release\\' -and
    $_.FullName -notmatch '\\releases\\' -and
    $_.FullName -notmatch '\\dist\\' -and
    $_.FullName -notmatch '\\build\\'
  } |
  ForEach-Object {
    $relative = Resolve-Path -Path $_.FullName -Relative
    [PSCustomObject]@{
      Path = $relative.TrimStart(".\")
      SizeMB = [Math]::Round($_.Length / 1MB, 1)
    }
  }

if ($largeTrackedFiles) {
  Write-Host ""
  Write-Host "[WARN] Large source files were found. GitHub may reject files over 100 MB:" -ForegroundColor Yellow
  $largeTrackedFiles | ForEach-Object {
    Write-Host ("  {0} MB  {1}" -f $_.SizeMB, $_.Path)
  }
}

$staged = (& git diff --cached --name-only)
if ($staged) {
  Run-Git @("commit", "-m", "Release $tag")
} else {
  Write-Host "No staged source changes to commit."
}

$tagExists = $false
& git rev-parse -q --verify "refs/tags/$tag" *> $null
if ($LASTEXITCODE -eq 0) {
  $tagExists = $true
  Write-Host "Tag $tag already exists locally; keeping it."
} else {
  Run-Git @("tag", $tag)
}

Run-Git @("push", "origin", $branch)
if (-not $tagExists) {
  Run-Git @("push", "origin", $tag)
} else {
  Run-Git @("push", "origin", "--tags")
}

if (-not $SkipGithubRelease) {
  $zip = Join-Path "releases" "shangpin-cloud-assets-$version.zip"
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if ($gh -and (Test-Path $zip)) {
    & gh release view $tag *> $null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "GitHub Release $tag already exists; uploading package asset."
      & gh release upload $tag $zip --clobber
    } else {
      Write-Host "Creating GitHub Release $tag and uploading package asset."
      & gh release create $tag $zip --title $tag --notes "Release $tag"
    }
    if ($LASTEXITCODE -ne 0) {
      Write-Host "[WARN] GitHub Release asset upload failed. Source backup and tag were pushed." -ForegroundColor Yellow
    }
  } elseif (-not $gh) {
    Write-Host "[INFO] GitHub CLI 'gh' not found; skipped uploading the zip to GitHub Releases."
  } elseif (-not (Test-Path $zip)) {
    Write-Host "[INFO] Release zip not found; skipped GitHub Release asset upload: $zip"
  }
}

Write-Host ""
Write-Host "[OK] GitHub backup complete."
