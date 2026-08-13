[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [string]$TaskName = 'JUNKMAN Simulation Stack'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
  throw 'This hardening script must run from an elevated Administrator PowerShell session.'
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$stackScript = Join-Path $RepoRoot 'run-junk-stack.ps1'
$keepaliveScript = Join-Path $RepoRoot 'ops\ensure-junk-stack-running.ps1'
if (-not (Test-Path -LiteralPath $stackScript -PathType Leaf)) {
  throw "JUNKMAN stack supervisor not found: $stackScript"
}
if (-not (Test-Path -LiteralPath $keepaliveScript -PathType Leaf)) {
  throw "JUNKMAN keepalive not found: $keepaliveScript"
}

$result = [ordered]@{
  applied_at = (Get-Date).ToUniversalTime().ToString('o')
  computer = $env:COMPUTERNAME
  user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  windows_update_policy = @()
  services_disabled = @()
  services_failed = @()
  tasks_disabled = @()
  tasks_failed = @()
  services_verified = @()
  tasks_verified = @()
  power_settings = @()
  startup_task = $null
  hardening_complete = $false
  verification_failures = @()
}

function Set-DwordValue {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][int]$Value
  )
  New-Item -Path $Path -Force | Out-Null
  New-ItemProperty -Path $Path -Name $Name -PropertyType DWord -Value $Value -Force | Out-Null
  $script:result.windows_update_policy += "$Path::$Name=$Value"
}

# Disable unattended Windows downloads/installs and prohibit Windows Update from
# automatically rebooting an interactive session. Manual maintenance remains
# possible after temporarily reversing these policies.
$wuPolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate'
$auPolicy = Join-Path $wuPolicy 'AU'
Set-DwordValue -Path $auPolicy -Name 'NoAutoUpdate' -Value 1
Set-DwordValue -Path $auPolicy -Name 'AUOptions' -Value 2
Set-DwordValue -Path $auPolicy -Name 'NoAutoRebootWithLoggedOnUsers' -Value 1
Set-DwordValue -Path $auPolicy -Name 'AlwaysAutoRebootAtScheduledTime' -Value 0
Set-DwordValue -Path $wuPolicy -Name 'SetActiveHours' -Value 1
Set-DwordValue -Path $wuPolicy -Name 'ActiveHoursStart' -Value 12
Set-DwordValue -Path $wuPolicy -Name 'ActiveHoursEnd' -Value 6
Set-DwordValue -Path $wuPolicy -Name 'ExcludeWUDriversInQualityUpdate' -Value 1

$wuUx = 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'
Set-DwordValue -Path $wuUx -Name 'ActiveHoursStart' -Value 12
Set-DwordValue -Path $wuUx -Name 'ActiveHoursEnd' -Value 6

# Disable unattended application-store and browser updaters as well. Security
# definitions, ACPI/thermal firmware, and critical-battery handling are not
# disabled by this script.
Set-DwordValue `
  -Path 'HKLM:\SOFTWARE\Policies\Microsoft\WindowsStore' `
  -Name 'AutoDownload' `
  -Value 2
Set-DwordValue `
  -Path 'HKLM:\SOFTWARE\Policies\Microsoft\EdgeUpdate' `
  -Name 'UpdateDefault' `
  -Value 0
Set-DwordValue `
  -Path 'HKLM:\SOFTWARE\Policies\Google\Update' `
  -Name 'UpdateDefault' `
  -Value 0
Set-DwordValue `
  -Path 'HKLM:\SOFTWARE\Policies\Google\Update' `
  -Name 'AutoUpdateCheckPeriodMinutes' `
  -Value 0

function Disable-ServiceSafely {
  param([Parameter(Mandatory = $true)][string]$Name)
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $service) { return }
  try {
    if ($service.Status -ne 'Stopped') {
      Stop-Service -Name $Name -Force -ErrorAction Stop
    }
    Set-Service -Name $Name -StartupType Disabled -ErrorAction Stop
    $script:result.services_disabled += $Name
  } catch {
    $script:result.services_failed += [ordered]@{ name = $Name; error = $_.Exception.Message }
  }
}

# Windows/Store delivery, browser updaters, and OEM update agents can replace or
# restart dependencies while the market watcher is active. BITS, Defender,
# thermal protection, critical-battery actions, and crash recovery are retained.
$servicesToDisable = @(
  'wuauserv',
  'UsoSvc',
  'WaaSMedicSvc',
  'DoSvc',
  'InstallService',
  'edgeupdate',
  'edgeupdatem',
  'gupdate',
  'gupdatem'
)
$servicesToDisable += Get-Service -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'GoogleUpdater*' } |
  Select-Object -ExpandProperty Name
$servicesToDisable | Sort-Object -Unique | ForEach-Object { Disable-ServiceSafely -Name $_ }

function Disable-TaskSafely {
  param([Parameter(Mandatory = $true)]$Task)
  $qualifiedName = "$($Task.TaskPath)$($Task.TaskName)"
  try {
    Disable-ScheduledTask -InputObject $Task -ErrorAction Stop | Out-Null
    $script:result.tasks_disabled += $qualifiedName
  } catch {
    $script:result.tasks_failed += [ordered]@{ name = $qualifiedName; error = $_.Exception.Message }
  }
}

$taskMatchers = @(
  '^\\Microsoft\\Windows\\UpdateOrchestrator\\',
  '^\\Microsoft\\Windows\\WindowsUpdate\\',
  '^\\Microsoft\\Windows\\WaaSMedic\\',
  '^\\Microsoft\\Windows\\InstallService\\',
  '^\\Microsoft\\Office\\Office Automatic Updates 2\.0$',
  '^\\Microsoft\\Office\\Office Feature Updates(?: Logon)?$',
  '^\\Dell SupportAssistAgent AutoUpdate$',
  '^\\OneDrive Standalone Update Task-',
  '^\\WpsUpdate(?:Logon)?Task_',
  '^\\ZoomUpdateTaskUser-',
  '^\\Microsoft\\VisualStudio\\Updates\\BackgroundDownload$',
  '^\\Microsoft\\Windows\\Maps\\MapsUpdateTask$',
  '^\\Microsoft\\Windows\\DirectX\\DirectXDatabaseUpdater$',
  '^\\Microsoft\\Windows\\PCRPF\\PCR Prediction Framework Firmware Update Task$'
)

Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object {
  $qualifiedName = "$($_.TaskPath)$($_.TaskName)"
  if ($taskMatchers | Where-Object { $qualifiedName -match $_ }) {
    Disable-TaskSafely -Task $_
  }
}

foreach ($serviceName in @($servicesToDisable | Sort-Object -Unique)) {
  $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction SilentlyContinue
  if ($service) {
    $result.services_verified += [ordered]@{
      name = $service.Name
      state = $service.State
      start_mode = $service.StartMode
      disabled = ([string]$service.StartMode -eq 'Disabled')
    }
  }
}
Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object {
  $qualifiedName = "$($_.TaskPath)$($_.TaskName)"
  if ($taskMatchers | Where-Object { $qualifiedName -match $_ }) {
    $result.tasks_verified += [ordered]@{
      name = $qualifiedName
      state = [string]$_.State
      disabled = ([string]$_.State -eq 'Disabled')
    }
  }
}

function Set-PowerValue {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('AC', 'DC')][string]$PowerSource,
    [Parameter(Mandatory = $true)][string]$SubGroup,
    [Parameter(Mandatory = $true)][string]$Setting,
    [Parameter(Mandatory = $true)][int]$Value
  )
  $verb = if ($PowerSource -eq 'AC') { '/setacvalueindex' } else { '/setdcvalueindex' }
  & powercfg.exe $verb SCHEME_CURRENT $SubGroup $Setting $Value
  if ($LASTEXITCODE -ne 0) {
    throw "powercfg failed: $verb SCHEME_CURRENT $SubGroup $Setting $Value"
  }
  $script:result.power_settings += "$PowerSource/$SubGroup/$Setting=$Value"
}

foreach ($source in @('AC', 'DC')) {
  Set-PowerValue -PowerSource $source -SubGroup 'SUB_BUTTONS' -Setting 'LIDACTION' -Value 0
  Set-PowerValue -PowerSource $source -SubGroup 'SUB_BUTTONS' -Setting 'PBUTTONACTION' -Value 0
  Set-PowerValue -PowerSource $source -SubGroup 'SUB_BUTTONS' -Setting 'SBUTTONACTION' -Value 0
  Set-PowerValue -PowerSource $source -SubGroup 'SUB_SLEEP' -Setting 'STANDBYIDLE' -Value 0
  Set-PowerValue -PowerSource $source -SubGroup 'SUB_SLEEP' -Setting 'HIBERNATEIDLE' -Value 0
  Set-PowerValue -PowerSource $source -SubGroup 'SUB_SLEEP' -Setting 'HYBRIDSLEEP' -Value 0
  Set-PowerValue -PowerSource $source -SubGroup 'SUB_SLEEP' -Setting '7bc4a2f9-d8fc-4469-b07b-33eb785aaca0' -Value 0
  Set-PowerValue -PowerSource $source -SubGroup 'SUB_SLEEP' -Setting 'abfc2519-3608-4c2a-94ea-171b0ed546ab' -Value 0
  Set-PowerValue -PowerSource $source -SubGroup 'SUB_SLEEP' -Setting 'd4c1d4c8-d5cc-43d3-b83e-fc51215cb04d' -Value 0
}
& powercfg.exe /setactive SCHEME_CURRENT
if ($LASTEXITCODE -ne 0) { throw 'Unable to reactivate the current power scheme.' }

# Run a short keepalive at every interactive sign-in and once per minute. The
# keepalive owns no trading rules; it starts or replaces the top-level watchdog
# when its process/heartbeat is missing or stale, then exits successfully. This
# avoids IgnoreNew false errors and also detects a hung watchdog.
# If a limited-user fallback task is already running, stop only its exact
# top-level process first. Child services are intentionally left alive.
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $commandLine = [string]$_.CommandLine
    $_.Name -match '^(powershell|pwsh)\.exe$' -and
    $commandLine -match '(?i)-File\s+' -and
    $commandLine.IndexOf($stackScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Seconds 2

$taskAction = New-ScheduledTaskAction `
  -Execute (Join-Path $PSHOME 'powershell.exe') `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$keepaliveScript`" -RepoRoot `"$RepoRoot`""
$keepaliveTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$taskTriggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $result.user),
  $keepaliveTrigger
)
$taskPrincipal = New-ScheduledTaskPrincipal `
  -UserId $result.user `
  -LogonType Interactive `
  -RunLevel Highest
$taskSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -WakeToRun `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew
$registered = Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $taskAction `
  -Trigger $taskTriggers `
  -Principal $taskPrincipal `
  -Settings $taskSettings `
  -Description 'Keeps the simulate-only JUNKMAN trading stack available after sign-in.' `
  -Force
$result.startup_task = [ordered]@{
  name = $registered.TaskName
  path = $registered.TaskPath
  state = [string]$registered.State
}

# The scheduled keepalive is intentionally short-lived. It verifies or starts
# the separate long-running watchdog and then exits with zero.
Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
  Start-Sleep -Milliseconds 500
  $runningTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ([string]$runningTask.State -ne 'Running') { break }
}
$runningTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$runningInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
$result.startup_task.state = [string]$runningTask.State
$result.startup_task.last_run_time = $runningInfo.LastRunTime.ToUniversalTime().ToString('o')
$result.startup_task.last_task_result = [int]$runningInfo.LastTaskResult
$result.startup_task.watchdog_process_count = @(
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $commandLine = [string]$_.CommandLine
      $_.Name -match '^(powershell|pwsh)\.exe$' -and
      $commandLine -match '(?i)-File\s+' -and
      $commandLine.IndexOf($stackScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }
).Count
$heartbeatFresh = $false
try {
  $heartbeatPath = Join-Path $RepoRoot 'logs\junk-stack-heartbeat.json'
  $heartbeat = Get-Content -LiteralPath $heartbeatPath -Raw -ErrorAction Stop | ConvertFrom-Json
  $heartbeatAt = [DateTimeOffset]::Parse(
    [string]$heartbeat.updated_at,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal
  ).ToUniversalTime()
  $heartbeatFresh = (
    [string]$heartbeat.phase -in @('starting', 'running') -and
    ([DateTimeOffset]::UtcNow - $heartbeatAt).TotalSeconds -le 120
  )
} catch { }
$result.startup_task.heartbeat_fresh = $heartbeatFresh
if (
  [int]$runningInfo.LastTaskResult -ne 0 -or
  [int]$result.startup_task.watchdog_process_count -ne 1 -or
  -not $heartbeatFresh
) {
  throw "The $TaskName keepalive did not verify one fresh watchdog."
}

# Do not report success when Windows protected an updater service/task from the
# requested change. The watchdog remains installed and running, but this script
# exits non-zero until every updater component it discovered is verified off.
$result.verification_failures += @(
  $result.services_verified |
    Where-Object { -not $_.disabled } |
    ForEach-Object { "service_not_disabled:$($_.name):$($_.start_mode)" }
)
$result.verification_failures += @(
  $result.services_failed |
    ForEach-Object { "service_change_failed:$($_.name)" }
)
$result.verification_failures += @(
  $result.tasks_verified |
    Where-Object { -not $_.disabled } |
    ForEach-Object { "task_not_disabled:$($_.name):$($_.state)" }
)
$result.verification_failures += @(
  $result.tasks_failed |
    ForEach-Object { "task_change_failed:$($_.name)" }
)
$result.verification_failures = @($result.verification_failures | Sort-Object -Unique)
$result.hardening_complete = (
  $result.verification_failures.Count -eq 0 -and
  [int]$runningInfo.LastTaskResult -eq 0 -and
  [int]$result.startup_task.watchdog_process_count -eq 1 -and
  $heartbeatFresh
)

$logDirectory = Join-Path $RepoRoot 'logs'
New-Item -Path $logDirectory -ItemType Directory -Force | Out-Null
$reportPath = Join-Path $logDirectory 'windows-unattended-hardening-report.json'
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding UTF8
$result | ConvertTo-Json -Depth 6
if (-not $result.hardening_complete) {
  throw "Unattended hardening is incomplete. Review $reportPath before relying on it."
}
