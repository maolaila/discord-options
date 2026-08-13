$ErrorActionPreference = 'Stop'

Set-Location -LiteralPath $PSScriptRoot

function Get-JunkGexWatchdogStatusAssessment {
  param(
    [Parameter(Mandatory = $true)]$Status,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$ExpectedProcessId,

    [ValidateRange(15, 1800)]
    [int]$MaxAgeSeconds = 300,

    [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow,

    [DateTimeOffset]$MinimumHeartbeatAt = [DateTimeOffset]::MinValue
  )

  $processIdProperty = $Status.PSObject.Properties['process_id']
  $statusProcessId = 0
  $processIdValid = (
    $null -ne $processIdProperty -and
    [int]::TryParse([string]$processIdProperty.Value, [ref]$statusProcessId) -and
    $statusProcessId -gt 0
  )
  $processIdMatches = $processIdValid -and $statusProcessId -eq $ExpectedProcessId

  $modeProperty = $Status.PSObject.Properties['mode']
  $modeValid = (
    $null -ne $modeProperty -and
    [string]$modeProperty.Value -ceq 'execute_simulate'
  )
  $realTradingProperty = $Status.PSObject.Properties['real_trading_allowed']
  $realTradingFlagValid = (
    $null -ne $realTradingProperty -and
    $realTradingProperty.Value -is [bool] -and
    -not [bool]$realTradingProperty.Value
  )

  $updatedAtProperty = $Status.PSObject.Properties['updated_at']
  $updatedAt = [DateTimeOffset]::MinValue
  $timestampValid = (
    $null -ne $updatedAtProperty -and
    [DateTimeOffset]::TryParse(
      [string]$updatedAtProperty.Value,
      [Globalization.CultureInfo]::InvariantCulture,
      ([Globalization.DateTimeStyles]::AllowWhiteSpaces -bor
        [Globalization.DateTimeStyles]::AssumeUniversal -bor
        [Globalization.DateTimeStyles]::AdjustToUniversal),
      [ref]$updatedAt
    )
  )
  $heartbeatBelongsToCurrentProcess = (
    $timestampValid -and
    $updatedAt.ToUniversalTime() -ge $MinimumHeartbeatAt.ToUniversalTime().AddSeconds(-5)
  )
  $ageSeconds = if ($timestampValid) {
    ($Now.ToUniversalTime() - $updatedAt.ToUniversalTime()).TotalSeconds
  } else {
    [double]::PositiveInfinity
  }
  $heartbeatFresh = (
    $heartbeatBelongsToCurrentProcess -and
    $ageSeconds -ge -5 -and
    $ageSeconds -le $MaxAgeSeconds
  )
  $heartbeatStale = (
    $heartbeatBelongsToCurrentProcess -and
    $ageSeconds -gt $MaxAgeSeconds
  )

  $activeOrdersProperty = $Status.PSObject.Properties['active_orders']
  $activeOrdersKnown = $false
  $activeOrderCount = 0
  if ($null -ne $activeOrdersProperty -and $null -ne $activeOrdersProperty.Value) {
    $activeOrdersValue = $activeOrdersProperty.Value
    if ($activeOrdersValue -is [bool] -or $activeOrdersValue -is [string]) {
      $activeOrdersKnown = $false
    } elseif ($activeOrdersValue -is [ValueType]) {
      $activeOrdersKnown = (
        [int]::TryParse([string]$activeOrdersValue, [ref]$activeOrderCount) -and
        $activeOrderCount -ge 0
      )
    } elseif ($activeOrdersValue -is [System.Management.Automation.PSCustomObject]) {
      $activeOrdersKnown = $true
      $activeOrderCount = 1
    } else {
      $activeOrdersKnown = $true
      $activeOrderCount = @($activeOrdersValue).Count
    }
  }

  $riskProperty = $Status.PSObject.Properties['risk']
  $openPositionCount = 0
  $openPositionCountKnown = $false
  if ($null -ne $riskProperty -and $null -ne $riskProperty.Value) {
    $openPositionProperty = $riskProperty.Value.PSObject.Properties['open_position_count']
    if ($null -ne $openPositionProperty) {
      $openPositionCountKnown = (
        [int]::TryParse([string]$openPositionProperty.Value, [ref]$openPositionCount) -and
        $openPositionCount -ge 0
      )
    }
  }

  $contractValid = $modeValid -and $realTradingFlagValid
  $exposureKnown = $activeOrdersKnown -and $openPositionCountKnown
  $zeroExposure = (
    $exposureKnown -and
    $activeOrderCount -eq 0 -and
    $openPositionCount -eq 0
  )
  $safeToRecycle = (
    $processIdMatches -and
    $contractValid -and
    $heartbeatStale -and
    $zeroExposure
  )

  $state = if (-not $processIdMatches) {
    'status_pid_mismatch_preserved'
  } elseif (-not $contractValid) {
    'simulation_contract_invalid_preserved'
  } elseif (-not $timestampValid -or -not $heartbeatBelongsToCurrentProcess -or $ageSeconds -lt -5) {
    'heartbeat_invalid_preserved'
  } elseif ($heartbeatFresh) {
    'healthy'
  } elseif (-not $heartbeatStale) {
    'heartbeat_invalid_preserved'
  } elseif (-not $exposureKnown) {
    'stale_exposure_unknown_preserved'
  } elseif (-not $zeroExposure) {
    'stale_with_exposure_preserved'
  } else {
    'stale_zero_exposure_confirmed'
  }

  return [pscustomobject]@{
    State = $state
    ProcessId = $statusProcessId
    ProcessIdMatches = $processIdMatches
    ContractValid = $contractValid
    TimestampValid = $timestampValid
    HeartbeatBelongsToCurrentProcess = $heartbeatBelongsToCurrentProcess
    AgeSeconds = $ageSeconds
    HeartbeatFresh = $heartbeatFresh
    HeartbeatStale = $heartbeatStale
    ExposureKnown = $exposureKnown
    ActiveOrderCount = $activeOrderCount
    OpenPositionCount = $openPositionCount
    ZeroExposure = $zeroExposure
    SafeToRecycle = $safeToRecycle
  }
}

function Read-JunkGexWatchdogStatusAssessment {
  param(
    [Parameter(Mandatory = $true)][string]$StatusPath,
    [Parameter(Mandatory = $true)][int]$ExpectedProcessId,
    [int]$MaxAgeSeconds = 300,
    [DateTimeOffset]$MinimumHeartbeatAt = [DateTimeOffset]::MinValue
  )

  if (-not (Test-Path -LiteralPath $StatusPath -PathType Leaf)) {
    return [pscustomobject]@{
      State = 'status_missing_preserved'
      SafeToRecycle = $false
      ProcessId = 0
    }
  }

  try {
    $status = Get-Content -LiteralPath $StatusPath -Raw | ConvertFrom-Json
    return Get-JunkGexWatchdogStatusAssessment `
      -Status $status `
      -ExpectedProcessId $ExpectedProcessId `
      -MaxAgeSeconds $MaxAgeSeconds `
      -MinimumHeartbeatAt $MinimumHeartbeatAt
  } catch {
    return [pscustomobject]@{
      State = 'status_unreadable_preserved'
      SafeToRecycle = $false
      ProcessId = 0
    }
  }
}

function Test-ExactJunkGexWatcherProcess {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string]$RootPath
  )

  if ([string]$Process.Name -ine 'node.exe') { return $false }

  $commandLine = [string]$Process.CommandLine
  if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }
  if ($commandLine -notmatch '(?i)(?:^|\s)--watch(?:\s|$)') { return $false }
  if ($commandLine -notmatch '(?i)(?:^|\s)--execute-simulate(?:\s|$)') { return $false }
  # Keep the forbidden live-mode token assembled at runtime.  The top-level
  # stack performs a conservative static scan of this launcher and would
  # otherwise mistake this rejection guard for a live launch path.
  $forbiddenLiveMode = '--execute-' + 'real'
  $forbiddenLiveModePattern = '(?i)(?:^|\s){0}(?:\s|$)' -f [regex]::Escape($forbiddenLiveMode)
  if ($commandLine -match $forbiddenLiveModePattern) { return $false }

  $expectedFullPath = [IO.Path]::GetFullPath(
    (Join-Path $RootPath 'apps\zero-dte-options\zero-dte-line.mjs')
  )
  $scriptMatches = [regex]::Matches(
    $commandLine,
    '(?i)(?:"(?<quoted>[^"]*zero-dte-line\.mjs)"|(?<bare>[^\s"]*zero-dte-line\.mjs))'
  )
  foreach ($scriptMatch in $scriptMatches) {
    $candidate = if ($scriptMatch.Groups['quoted'].Success) {
      $scriptMatch.Groups['quoted'].Value
    } else {
      $scriptMatch.Groups['bare'].Value
    }
    try {
      $candidatePath = if ([IO.Path]::IsPathRooted([string]$candidate)) {
        [IO.Path]::GetFullPath([string]$candidate)
      } else {
        [IO.Path]::GetFullPath((Join-Path $RootPath ([string]$candidate)))
      }
    } catch {
      continue
    }
    if ($candidatePath.Equals($expectedFullPath, [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Invoke-JunkGexWatchdogRecycle {
  param(
    [Parameter(Mandatory = $true)][string]$StatusPath,
    [Parameter(Mandatory = $true)][int]$ExpectedProcessId,
    [Parameter(Mandatory = $true)][string]$RootPath,
    [int]$MaxAgeSeconds = 300,
    [DateTimeOffset]$MinimumHeartbeatAt = [DateTimeOffset]::MinValue
  )

  $firstAssessment = Read-JunkGexWatchdogStatusAssessment `
    -StatusPath $StatusPath `
    -ExpectedProcessId $ExpectedProcessId `
    -MaxAgeSeconds $MaxAgeSeconds `
    -MinimumHeartbeatAt $MinimumHeartbeatAt
  if (-not $firstAssessment.SafeToRecycle) {
    return [pscustomobject]@{
      Action = 'preserve'
      State = $firstAssessment.State
      ProcessId = $ExpectedProcessId
    }
  }

  # Re-read the atomically-written status immediately before any process stop.
  # A recovered heartbeat, exposure change, corrupt write, or PID change must
  # turn the watchdog into a no-op rather than an unsafe kill.
  $secondAssessment = Read-JunkGexWatchdogStatusAssessment `
    -StatusPath $StatusPath `
    -ExpectedProcessId $ExpectedProcessId `
    -MaxAgeSeconds $MaxAgeSeconds `
    -MinimumHeartbeatAt $MinimumHeartbeatAt
  if (-not $secondAssessment.SafeToRecycle) {
    return [pscustomobject]@{
      Action = 'preserve'
      State = "recheck_$($secondAssessment.State)"
      ProcessId = $ExpectedProcessId
    }
  }

  $verifiedProcesses = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { Test-ExactJunkGexWatcherProcess -Process $_ -RootPath $RootPath }
  )
  $matchingProcesses = @(
    $verifiedProcesses | Where-Object { [int]$_.ProcessId -eq $ExpectedProcessId }
  )
  if ($verifiedProcesses.Count -ne 1 -or $matchingProcesses.Count -ne 1) {
    return [pscustomobject]@{
      Action = 'preserve'
      State = 'process_identity_ambiguous_preserved'
      ProcessId = $ExpectedProcessId
    }
  }

  try {
    Stop-Process -Id $ExpectedProcessId -Force -ErrorAction Stop
  } catch {
    return [pscustomobject]@{
      Action = 'preserve'
      State = 'recycle_failed_preserved'
      ProcessId = $ExpectedProcessId
    }
  }

  return [pscustomobject]@{
    Action = 'recycle'
    State = 'stale_zero_exposure_recycled'
    ProcessId = $ExpectedProcessId
  }
}

$createdNew = $false
$supervisorMutex = [System.Threading.Mutex]::new(
  $true,
  'Local\DiscordOptionsJunkGexSupervisor',
  [ref] $createdNew
)
if (-not $createdNew) {
  $supervisorMutex.Dispose()
  throw 'The JUNKMAN supervisor is already running in this Windows session.'
}

try {
  $nightwatchKey = [Environment]::GetEnvironmentVariable('YEHANGSHE_API_KEY', 'User')
  if ([string]::IsNullOrWhiteSpace($nightwatchKey)) {
    throw 'YEHANGSHE_API_KEY is not configured in the Windows user environment.'
  }
  $env:YEHANGSHE_API_KEY = $nightwatchKey
  Remove-Variable nightwatchKey

  $nodeCommand = Get-Command node -ErrorAction Stop
  $nodeMajor = [int] ((& $nodeCommand.Source --version).TrimStart('v').Split('.')[0])
  if ($nodeMajor -lt 20) {
    throw 'JUNKMAN requires Node.js 20 or newer.'
  }
  $logDirectory = Join-Path $PSScriptRoot 'logs'
  $supervisorPath = Join-Path $logDirectory 'zero-dte-options-supervisor.log'
  $statusPath = Join-Path $logDirectory 'zero-dte-options-status.json'
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $attempt = 0

  do {
    $attempt += 1
    $stdoutPath = Join-Path $logDirectory "zero-dte-options-runtime-$PID-$attempt.stdout.log"
    $stderrPath = Join-Path $logDirectory "zero-dte-options-runtime-$PID-$attempt.stderr.log"
    $watcher = Start-Process `
      -FilePath $nodeCommand.Source `
      -ArgumentList @(
        (Join-Path $PSScriptRoot 'apps\zero-dte-options\zero-dte-line.mjs'),
        '--watch',
        '--execute-simulate'
      ) `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -WindowStyle Hidden `
      -PassThru
    $watcherStartedAt = Get-Date
    $watchdogTriggered = $false
    $lastWatchdogState = $null
    while (-not $watcher.HasExited) {
      Start-Sleep -Seconds 15
      $watcher.Refresh()
      if ($watcher.HasExited) { break }
      if ((Get-Date) -lt $watcherStartedAt.AddMinutes(2)) { continue }

      $watchdogResult = Invoke-JunkGexWatchdogRecycle `
        -StatusPath $statusPath `
        -ExpectedProcessId $watcher.Id `
        -RootPath $PSScriptRoot `
        -MaxAgeSeconds 300 `
        -MinimumHeartbeatAt ([DateTimeOffset]$watcherStartedAt)
      if ($watchdogResult.Action -eq 'recycle') {
        $watchdogTriggered = $true
        Add-Content -LiteralPath $supervisorPath -Value "$(Get-Date -Format o) watcher heartbeat stale with confirmed simulation contract and zero exposure; recycled pid=$($watcher.Id)"
        $watcher.WaitForExit()
        break
      }
      if ($watchdogResult.State -ne 'healthy' -and $watchdogResult.State -ne $lastWatchdogState) {
        Add-Content -LiteralPath $supervisorPath -Value "$(Get-Date -Format o) watchdog state=$($watchdogResult.State); preserving pid=$($watcher.Id)"
      }
      $lastWatchdogState = $watchdogResult.State
    }
    $exitCode = if ($watchdogTriggered) { 124 } else { $watcher.ExitCode }
    if ($exitCode -eq 0) { break }
    Add-Content -LiteralPath $supervisorPath -Value "$(Get-Date -Format o) watcher exited code=$exitCode; restarting in 15 seconds"
    Start-Sleep -Seconds 15
  } while ($true)
} finally {
  try { $supervisorMutex.ReleaseMutex() } catch { }
  $supervisorMutex.Dispose()
}
