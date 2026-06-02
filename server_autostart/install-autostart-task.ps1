$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDir '..'))
$taskName = 'ShangpinCloudAssets-Server'
$runScript = Join-Path $scriptDir 'run-server.ps1'
$logDir = Join-Path $env:ProgramData 'ShangpinCloudAssets'
$runtimeLog = Join-Path $logDir 'server-autostart.log'
$taskLog = Join-Path $logDir 'task-run.log'
$installLog = Join-Path $logDir 'install-task.log'
$bootWrapper = Join-Path $logDir 'boot-run.ps1'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Write-InstallLog {
    param([string]$Message)
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $installLog -Value "[$timestamp] $Message" -Encoding UTF8
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Add-Content -Path $installLog -Value '==================================================' -Encoding UTF8
Write-InstallLog "Installing task..."
Write-InstallLog "ScriptDir=$scriptDir"
Write-InstallLog "ProjectRoot=$projectRoot"
Write-InstallLog "RunScript=$runScript"
Write-InstallLog "RuntimeLog=$runtimeLog"
Write-InstallLog "TaskLog=$taskLog"
Write-InstallLog "BootWrapper=$bootWrapper"

if (-not (Test-Path $runScript)) {
    throw "Missing run script: $runScript"
}

$runScriptEscaped = $runScript.Replace("'", "''")
$taskLogEscaped = $taskLog.Replace("'", "''")
$bootWrapperContent = @"
`$ErrorActionPreference = 'Continue'
`$run = '$runScriptEscaped'
`$taskLog = '$taskLogEscaped'
function Write-TaskLog([string]`$Message) {
    `$timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path `$taskLog -Value "[`$timestamp] `$Message" -Encoding UTF8
}
Write-TaskLog '=================================================='
Write-TaskLog 'Boot task starting.'
Write-TaskLog ('RunScript=' + `$run)
if (-not (Test-Path `$run)) {
    Write-TaskLog ('[ERROR] Missing run script: ' + `$run)
    exit 1
}
& '$psExe' -NoProfile -ExecutionPolicy Bypass -File `$run *>> `$taskLog
`$exitCode = `$LASTEXITCODE
Write-TaskLog ('Boot task finished. Exit code: ' + `$exitCode)
exit `$exitCode
"@
[System.IO.File]::WriteAllText($bootWrapper, $bootWrapperContent, [System.Text.Encoding]::UTF8)
Write-InstallLog "Boot wrapper written OK: $bootWrapper"

try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
} catch {
}

$action = New-ScheduledTaskAction -Execute $psExe -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$bootWrapper`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Write-InstallLog "Task created OK."

$startupVbs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\ShangpinCloudAssets-Server.vbs'
Remove-Item -Path $startupVbs -Force -ErrorAction SilentlyContinue
Write-InstallLog "Removed old startup item: $startupVbs"

Write-Host
Write-Host "Done."
Write-Host "- Task: $taskName"
Write-Host "- It will start on boot automatically."
Write-Host "- Runtime log: $runtimeLog"
Write-Host "- Task log: $taskLog"
Write-Host "- Install log: $installLog"
Write-Host
Write-Host 'You can test it now by running:'
Write-Host "  schtasks /Run /TN `"$taskName`""
