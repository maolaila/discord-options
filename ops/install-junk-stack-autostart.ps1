param(
  [string]$TaskName = 'DiscordOptions-JUNKMAN-Stack',
  [ValidateRange(2, 60)]
  [int]$WatchdogIntervalMinutes = 5,
  [switch]$DoNotStart
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$stackScript = Join-Path $repoRoot 'run-junk-stack.ps1'
if (-not (Test-Path -LiteralPath $stackScript -PathType Leaf)) {
  throw "JUNKMAN stack entrypoint is missing: $stackScript"
}

$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powershellPath -PathType Leaf)) {
  throw "Windows PowerShell is missing: $powershellPath"
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$escapedStackScript = $stackScript.Replace('"', '""')
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $escapedStackScript

$action = New-ScheduledTaskAction `
  -Execute $powershellPath `
  -Argument $arguments `
  -WorkingDirectory $repoRoot
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
# Task Scheduler does not classify every externally terminated process as a
# restartable failure. This hidden periodic trigger is a low-frequency safety
# net: IgnoreNew makes it a no-op while the long-running stack is healthy, and
# starts it again within a few minutes if the process disappeared.
$watchdogTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes($WatchdogIntervalMinutes) `
  -RepetitionInterval (New-TimeSpan -Minutes $WatchdogIntervalMinutes)
$triggers = @($logonTrigger, $watchdogTrigger)
$principal = New-ScheduledTaskPrincipal `
  -UserId $identity `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -Hidden `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

$task = New-ScheduledTask `
  -Action $action `
  -Trigger $triggers `
  -Principal $principal `
  -Settings $settings `
  -Description 'Keeps the simulation-only JUNKMAN stack, Discord capture, and strategy supervisors running after user logon.'

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

if (-not $DoNotStart) {
  $registered = Get-ScheduledTask -TaskName $TaskName
  if ([string]$registered.State -ne 'Running') {
    Start-ScheduledTask -TaskName $TaskName
  }
}

$registered = Get-ScheduledTask -TaskName $TaskName
$info = $registered | Get-ScheduledTaskInfo
[pscustomobject]@{
  task_name = $TaskName
  state = [string]$registered.State
  last_run_time = $info.LastRunTime
  last_task_result = $info.LastTaskResult
  at_logon = $true
  watchdog_interval_minutes = $WatchdogIntervalMinutes
  hidden = [bool]$registered.Settings.Hidden
  restart_count = [int]$registered.Settings.RestartCount
  restart_interval = [string]$registered.Settings.RestartInterval
  simulation_entrypoint = $stackScript
}
