param(
  [ValidateRange(10, 300)]
  [int]$CheckIntervalSeconds = 30,

  [ValidateRange(15, 300)]
  [int]$StartupTimeoutSeconds = 90,

  [ValidateRange(15, 300)]
  [int]$WatcherStatusMaxAgeSeconds = 60,

  [ValidateRange(2, 20)]
  [int]$OpenDStallRestartChecks = 4,

  [ValidateRange(2, 10)]
  [int]$ConsoleStallRestartChecks = 3,

  [ValidateRange(15, 300)]
  [int]$MoomooHealthProbeIntervalSeconds = 60,

  [ValidateRange(15, 120)]
  [int]$MoomooHealthProbeTimeoutSeconds = 45,

  [ValidateRange(30, 180)]
  [int]$OpenDAuthRecoveryTimeoutSeconds = 90,

  [ValidateRange(120, 3600)]
  [int]$OpenDAuthRecoveryCooldownSeconds = 600,

  [ValidateRange(1, 65535)]
  [int]$OpenDPort = 33333,

  [ValidateRange(1, 65535)]
  [int]$ConsolePort = 18766,

  [ValidateRange(1, 65535)]
  [int]$CdpPort = 9222,

  [string]$OpenDPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot

$rootPath = $PSScriptRoot
$logDirectory = Join-Path $rootPath 'logs'
$stackLogPath = Join-Path $logDirectory 'junk-stack-supervisor.log'
$stackHeartbeatPath = Join-Path $logDirectory 'junk-stack-heartbeat.json'
$consoleScriptPath = Join-Path $rootPath 'apps\control-console\control-console.mjs'
$moomooCheckScriptPath = Join-Path $rootPath 'apps\opend-check\moomoo-check.mjs'
$moomooCheckResultPath = Join-Path $logDirectory 'moomoo-check.json'
$openDAuthRecoveryScriptPath = Join-Path $rootPath 'ops\recover-opend-websocket-auth.ps1'
$moomooProbeStdoutPath = Join-Path $logDirectory 'moomoo-stack-health.stdout.log'
$moomooProbeStderrPath = Join-Path $logDirectory 'moomoo-stack-health.stderr.log'
$openDAuthRecoveryStdoutPath = Join-Path $logDirectory 'opend-auth-recovery.stdout.log'
$openDAuthRecoveryStderrPath = Join-Path $logDirectory 'opend-auth-recovery.stderr.log'
$openDAuthRecoverySensitivePaths = @(
  (Join-Path $logDirectory '.opend-auth-recovery.png'),
  (Join-Path $logDirectory '.opend-auth-recovery.stdout.log'),
  (Join-Path $logDirectory '.opend-auth-recovery.stderr.log'),
  $openDAuthRecoveryStdoutPath,
  $openDAuthRecoveryStderrPath
)
$junkSupervisorPath = Join-Path $rootPath 'run-junk-gex.ps1'
$junkMultiSupervisorPath = Join-Path $rootPath 'run-junk-multi.ps1'
$junkFlowHeatmapSupervisorPath = Join-Path $rootPath 'run-junk-flow-heatmap.ps1'
$policyPath = Join-Path $rootPath 'config\zero-dte-options-policy.json'
$junkMultiPolicyPath = Join-Path $rootPath 'config\junk-multi-options-policy.json'
$junkFlowHeatmapPolicyPath = Join-Path $rootPath 'config\junk-flow-heatmap-options-policy.json'
$envPath = Join-Path $rootPath '.env'
$powershellPath = Join-Path $PSHOME 'powershell.exe'

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

$createdNew = $false
$stackMutex = [System.Threading.Mutex]::new(
  $true,
  'Local\DiscordOptionsJunkStackSupervisor',
  [ref]$createdNew
)
if (-not $createdNew) {
  $stackMutex.Dispose()
  Write-Output 'The JUNKMAN stack supervisor is already running in this Windows session.'
  exit 0
}

$script:componentStates = @{}
$script:openDDownChecks = 0
$script:consoleUnhealthyChecks = 0
$script:lastCdpHealthy = $null
$script:lastMoomooProbeAt = [DateTimeOffset]::MinValue
$script:lastMoomooApiHealthy = $false
$script:consecutiveMoomooApiFailures = 0
$script:lastOpenDAuthRecoveryAt = [DateTimeOffset]::MinValue
$script:junkWatcherRequiresSupervisorRemoval = $false

function Write-StackLog {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message,

    [ValidateSet('INFO', 'WARN', 'ERROR')]
    [string]$Level = 'INFO'
  )

  # Do not add environment values or child command lines here: they may contain secrets.
  $line = '{0} [{1}] {2}' -f (Get-Date -Format o), $Level, $Message
  Add-Content -LiteralPath $stackLogPath -Value $line -Encoding UTF8
}

function Set-ComponentState {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [string]$State,

    [Parameter(Mandatory = $true)]
    [string]$Detail,

    [ValidateSet('INFO', 'WARN', 'ERROR')]
    [string]$Level = 'INFO'
  )

  $fingerprint = "$State|$Detail"
  if ($script:componentStates[$Name] -eq $fingerprint) { return }
  $script:componentStates[$Name] = $fingerprint
  Write-StackLog -Level $Level -Message "$Name state=$State; $Detail"
}

function Write-StackHeartbeat {
  param([string]$Phase = 'running')

  try {
    $payload = [ordered]@{
      updated_at = [DateTimeOffset]::UtcNow.ToString('o')
      pid = $PID
      phase = $Phase
      simulation_only = $true
    }
    $temporaryPath = "$stackHeartbeatPath.$PID.tmp"
    $payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $stackHeartbeatPath -Force
  } catch {
    # The watchdog remains authoritative even if a transient filesystem write
    # fails. The external keepalive will retry based on process identity.
  }
}

function Test-LocalTcpPort {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port,

    [int]$TimeoutMilliseconds = 1000
  )

  $client = [System.Net.Sockets.TcpClient]::new()
  $asyncResult = $null
  try {
    $asyncResult = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) {
      return $false
    }
    $client.EndConnect($asyncResult)
    return [bool]$client.Connected
  } catch {
    return $false
  } finally {
    if ($null -ne $asyncResult) {
      try { $asyncResult.AsyncWaitHandle.Close() } catch { }
    }
    $client.Close()
  }
}

function Wait-LocalTcpPort {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (Test-LocalTcpPort -Port $Port) { return $true }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Wait-LocalTcpPortClosed {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (-not (Test-LocalTcpPort -Port $Port)) { return $true }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Stop-ExactProcessTree {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  # taskkill /T is used only with the exact PID returned by Start-Process. This
  # prevents an authentication-recovery timeout from leaving a Node probe alive.
  $taskkillPath = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  if (Test-Path -LiteralPath $taskkillPath -PathType Leaf) {
    & $taskkillPath /PID $ProcessId /T /F 1>$null 2>$null
    return
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Wait-BoundedProcess {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )

  try {
    if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
      Stop-ExactProcessTree -ProcessId ([int]$Process.Id)
      try { $null = $Process.WaitForExit(5000) } catch { }
      return [pscustomobject]@{
        Exited = $false
        TimedOut = $true
        ExitCode = $null
        Reason = 'timeout'
      }
    }

    # The bounded wait above has already observed process exit. This second call
    # only flushes redirected stream bookkeeping and cannot wait on a live child.
    $Process.WaitForExit()
    $Process.Refresh()
    return [pscustomobject]@{
      Exited = $true
      TimedOut = $false
      ExitCode = [int]$Process.ExitCode
      Reason = 'exited'
    }
  } catch {
    try { Stop-ExactProcessTree -ProcessId ([int]$Process.Id) } catch { }
    return [pscustomobject]@{
      Exited = $false
      TimedOut = $false
      ExitCode = $null
      Reason = 'wait_failed'
    }
  }
}

function Get-ExecutableNodeVersion {
  param([Parameter(Mandatory = $true)][string]$ExecutablePath)

  try {
    $versionText = (& $ExecutablePath --version 2>$null | Select-Object -First 1)
    if ($versionText -match '^v?(\d+)\.(\d+)\.(\d+)') {
      return [version]::new(
        [int]$Matches[1],
        [int]$Matches[2],
        [int]$Matches[3]
      )
    }
  } catch { }
  return [version]::new(0, 0, 0)
}

function Resolve-NodePath {
  $candidates = [System.Collections.Generic.List[string]]::new()
  foreach ($command in @(Get-Command node -All -ErrorAction SilentlyContinue)) {
    if ($command.Source) { $candidates.Add([string]$command.Source) }
  }

  $programFilesX86Node = $null
  if (${env:ProgramFiles(x86)}) {
    $programFilesX86Node = Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'
  }

  foreach ($candidate in @(
    (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin\node.exe'),
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    $programFilesX86Node
  )) {
    if ($candidate) { $candidates.Add([string]$candidate) }
  }

  foreach ($candidate in @($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    if ((Get-ExecutableNodeVersion -ExecutablePath $candidate) -ge [version]'24.15.0') {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  throw 'Node.js 24.15 or newer was not found. JUNKMAN requires the built-in node:sqlite release-candidate API.'
}

function Get-MoomooCheckValidation {
  param(
    [Parameter(Mandatory = $true)]$Payload,
    [Parameter(Mandatory = $true)][DateTimeOffset]$ProbeStartedAt,
    [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
  )

  try {
    $checkedAt = [DateTimeOffset]::Parse(
      [string]$Payload.checked_at,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::AssumeUniversal
    ).ToUniversalTime()
    if ($checkedAt -lt $ProbeStartedAt.AddSeconds(-2) -or $checkedAt -gt $Now.AddSeconds(30)) {
      return [pscustomobject]@{ Healthy = $false; Reason = 'checked_at_not_fresh'; CheckedAt = $checkedAt }
    }

    if (
      $Payload.global_state.s2c.qotLogined -ne $true -or
      $Payload.global_state.s2c.trdLogined -ne $true
    ) {
      return [pscustomobject]@{ Healthy = $false; Reason = 'qot_or_trd_not_logged_in'; CheckedAt = $checkedAt }
    }

    if ([int]$Payload.config.trdEnv -ne 0) {
      return [pscustomobject]@{ Healthy = $false; Reason = 'configured_trade_environment_not_simulate'; CheckedAt = $checkedAt }
    }

    $hasSimulatedUsOptionsAccount = $false
    foreach ($account in @($Payload.account_summary)) {
      if (
        [int]$account.trdEnv -eq 0 -and
        [int]$account.simAccType -eq 4 -and
        @($account.trdMarketAuthList) -contains 2
      ) {
        $hasSimulatedUsOptionsAccount = $true
        break
      }
    }
    if (-not $hasSimulatedUsOptionsAccount) {
      return [pscustomobject]@{ Healthy = $false; Reason = 'simulated_us_options_account_not_authorized'; CheckedAt = $checkedAt }
    }

    return [pscustomobject]@{ Healthy = $true; Reason = 'ok'; CheckedAt = $checkedAt }
  } catch {
    return [pscustomobject]@{ Healthy = $false; Reason = 'invalid_health_payload'; CheckedAt = $null }
  }
}

function Invoke-MoomooApiHealthProbe {
  param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [int]$TimeoutSeconds = $MoomooHealthProbeTimeoutSeconds
  )

  if ($TimeoutSeconds -lt 1) {
    return [pscustomobject]@{ Healthy = $false; Reason = 'probe_deadline_exhausted'; CheckedAt = $null }
  }

  Set-ComponentState `
    -Name 'moomoo_credentials' `
    -State 'shared_key_file' `
    -Detail 'source=.env:MOOMOO_OPEND_WS_KEY_FILE; websocket_key_value_is_never_logged'

  $probeStartedAt = [DateTimeOffset]::UtcNow
  $process = $null
  try {
    Remove-Item Env:MOOMOO_OPEND_WS_KEY -ErrorAction SilentlyContinue
    $process = Start-Process `
      -FilePath $NodePath `
      -ArgumentList ('"{0}"' -f $moomooCheckScriptPath) `
      -WorkingDirectory $rootPath `
      -WindowStyle Hidden `
      -RedirectStandardOutput $moomooProbeStdoutPath `
      -RedirectStandardError $moomooProbeStderrPath `
      -PassThru

    $waitResult = Wait-BoundedProcess -Process $process -TimeoutSeconds $TimeoutSeconds
    if ($waitResult.TimedOut) {
      return [pscustomobject]@{ Healthy = $false; Reason = 'probe_timeout'; CheckedAt = $null }
    }
    if (-not $waitResult.Exited) {
      return [pscustomobject]@{ Healthy = $false; Reason = 'probe_wait_failed'; CheckedAt = $null }
    }
    if ($waitResult.ExitCode -ne 0) {
      return [pscustomobject]@{ Healthy = $false; Reason = "probe_exit_$($waitResult.ExitCode)"; CheckedAt = $null }
    }

    if (-not (Test-Path -LiteralPath $moomooCheckResultPath -PathType Leaf)) {
      return [pscustomobject]@{ Healthy = $false; Reason = 'health_result_missing'; CheckedAt = $null }
    }
    $resultItem = Get-Item -LiteralPath $moomooCheckResultPath
    if ($resultItem.LastWriteTimeUtc -lt $probeStartedAt.UtcDateTime.AddSeconds(-2)) {
      return [pscustomobject]@{ Healthy = $false; Reason = 'health_result_file_stale'; CheckedAt = $null }
    }

    $payload = Get-Content -LiteralPath $moomooCheckResultPath -Raw | ConvertFrom-Json
    return Get-MoomooCheckValidation `
      -Payload $payload `
      -ProbeStartedAt $probeStartedAt `
      -Now ([DateTimeOffset]::UtcNow)
  } catch {
    return [pscustomobject]@{ Healthy = $false; Reason = 'probe_exception'; CheckedAt = $null }
  } finally {
    if ($null -ne $process) { $process.Dispose() }
    Remove-Item Env:MOOMOO_OPEND_WS_KEY -ErrorAction SilentlyContinue
  }
}

function Test-MoomooProbeLooksLikeAuthenticationFailure {
  if (-not (Test-Path -LiteralPath $moomooProbeStderrPath -PathType Leaf)) { return $false }
  try {
    $tail = @(Get-Content -LiteralPath $moomooProbeStderrPath -Tail 80 -ErrorAction Stop) -join "`n"
    return $tail -match 'Moomoo OpenD WebSocket login failed|Cannot read properties of null.*connID'
  } catch {
    return $false
  }
}

function Remove-OpenDAuthRecoveryArtifacts {
  foreach ($path in $openDAuthRecoverySensitivePaths) {
    if ([string]::IsNullOrWhiteSpace([string]$path)) { continue }
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-OpenDAuthRecovery {
  param([Parameter(Mandatory = $true)][int]$TimeoutSeconds)

  if ($TimeoutSeconds -lt 1) { return $false }
  if (-not (Test-Path -LiteralPath $openDAuthRecoveryScriptPath -PathType Leaf)) {
    return $false
  }

  $process = $null
  try {
    Remove-OpenDAuthRecoveryArtifacts
    Write-StackLog -Level 'WARN' -Message 'Attempting bounded local OpenD WebSocket authentication recovery; no credential value will be logged.'
    $process = Start-Process `
      -FilePath $powershellPath `
      -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        ('"{0}"' -f $openDAuthRecoveryScriptPath),
        '-RepoRoot',
        ('"{0}"' -f $rootPath)
      ) `
      -WorkingDirectory $rootPath `
      -WindowStyle Hidden `
      -RedirectStandardOutput $openDAuthRecoveryStdoutPath `
      -RedirectStandardError $openDAuthRecoveryStderrPath `
      -PassThru

    $waitResult = Wait-BoundedProcess -Process $process -TimeoutSeconds $TimeoutSeconds
    if ($waitResult.TimedOut) {
      Set-ComponentState `
        -Name 'opend_auth_recovery' `
        -State 'timed_out' `
        -Detail 'credential_value_not_logged=true; process_tree_stopped=true' `
        -Level 'ERROR'
      return $false
    }
    if (-not $waitResult.Exited -or $waitResult.ExitCode -ne 0) {
      Set-ComponentState `
        -Name 'opend_auth_recovery' `
        -State 'failed' `
        -Detail 'credential_value_not_logged=true' `
        -Level 'WARN'
      return $false
    }

    Set-ComponentState `
      -Name 'opend_auth_recovery' `
      -State 'candidate_authenticated' `
      -Detail 'awaiting_bounded_account_validation=true; credential_value_not_logged=true'
    # A zero exit code means the recovery child authenticated the candidate and
    # persisted it to the .env-selected secrets file. The following bounded
    # account probe is still authoritative before any strategy can start.
    return $true
  } catch {
    Set-ComponentState `
      -Name 'opend_auth_recovery' `
      -State 'error' `
      -Detail 'credential_value_not_logged=true' `
      -Level 'ERROR'
    return $false
  } finally {
    if ($null -ne $process) { $process.Dispose() }
    # A forced timeout bypasses the child script's finally block, so remove its
    # narrow OCR screenshot and all recovery output here as a second boundary.
    Remove-OpenDAuthRecoveryArtifacts
  }
}

function Get-DotEnvValue {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $escapedName = [regex]::Escape($Name)
  foreach ($line in Get-Content -LiteralPath $FilePath -ErrorAction Stop) {
    if ($line -match "^\s*$escapedName\s*=\s*(.*?)\s*$") {
      return ([string]$Matches[1]).Trim().Trim('"').Trim("'")
    }
  }
  return $null
}

function Assert-SimulationOnlyConfiguration {
  if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
    throw '.env is missing; JUNKMAN was not started.'
  }
  if (-not (Test-Path -LiteralPath $policyPath -PathType Leaf)) {
    throw 'The JUNKMAN policy is missing; JUNKMAN was not started.'
  }
  if (-not (Test-Path -LiteralPath $junkSupervisorPath -PathType Leaf)) {
    throw 'run-junk-gex.ps1 is missing; JUNKMAN was not started.'
  }
  if (-not (Test-Path -LiteralPath $junkMultiSupervisorPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $junkMultiPolicyPath -PathType Leaf)) {
    throw 'The JUNKMAN-MULTI simulation supervisor or policy is missing.'
  }
  if (-not (Test-Path -LiteralPath $junkFlowHeatmapSupervisorPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $junkFlowHeatmapPolicyPath -PathType Leaf)) {
    throw 'The JUNKMAN-FLOW-HEATMAP simulation supervisor or policy is missing.'
  }
  if (-not (Test-Path -LiteralPath $moomooCheckScriptPath -PathType Leaf)) {
    throw 'apps/opend-check/moomoo-check.mjs is missing; JUNKMAN was not started.'
  }

  $tradingEnvironment = Get-DotEnvValue -FilePath $envPath -Name 'MOOMOO_TRD_ENV'
  $allowRealTrading = Get-DotEnvValue -FilePath $envPath -Name 'MOOMOO_ALLOW_REAL_TRADING'
  if ($tradingEnvironment -ine 'simulate' -or $allowRealTrading -ine 'false') {
    throw '.env is not explicitly simulation-only; JUNKMAN was not started.'
  }

  $policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
  if (
    $policy.business_line.id -ne 'zero-dte-options' -or
    $policy.business_line.status -ne 'active_simulation' -or
    $policy.execution.environment -ne 'simulate_only' -or
    [bool]$policy.execution.real_trading_allowed
  ) {
    throw 'The active policy is not the JUNKMAN simulation-only policy.'
  }

  $junkMultiPolicy = Get-Content -LiteralPath $junkMultiPolicyPath -Raw | ConvertFrom-Json
  if ($junkMultiPolicy.business_line.id -ne 'junk-multi-options' -or
      $junkMultiPolicy.execution.environment -ne 'simulate_only' -or
      [bool]$junkMultiPolicy.execution.real_trading_allowed -or
      @($junkMultiPolicy.exit_experiment.lines).Count -ne 7 -or
      @($junkMultiPolicy.exit_experiment.lines | Where-Object {
        [double]$_.paper_equity_usd -ne 10000
      }).Count -ne 0) {
    throw 'The JUNKMAN-MULTI policy is not simulation-only with seven $10,000 lines.'
  }

  $junkFlowHeatmapPolicy = Get-Content -LiteralPath $junkFlowHeatmapPolicyPath -Raw | ConvertFrom-Json
  if ($junkFlowHeatmapPolicy.business_line.id -ne 'junk-flow-heatmap-options' -or
      $junkFlowHeatmapPolicy.execution.environment -ne 'simulate_only' -or
      [bool]$junkFlowHeatmapPolicy.execution.real_trading_allowed -or
      [bool]$junkFlowHeatmapPolicy.execution.ai_decisioning_allowed -or
      @($junkFlowHeatmapPolicy.exit_experiment.lines).Count -ne 7 -or
      @($junkFlowHeatmapPolicy.exit_experiment.lines | Where-Object {
        [double]$_.paper_equity_usd -ne 10000
      }).Count -ne 0) {
    throw 'The JUNKMAN-FLOW-HEATMAP policy is not deterministic simulation-only with seven $10,000 lines.'
  }

  $supervisorText = Get-Content -LiteralPath $junkSupervisorPath -Raw
  if ($supervisorText -notmatch '--execute-simulate' -or $supervisorText -match '--execute-real') {
    throw 'run-junk-gex.ps1 is not locked to --execute-simulate.'
  }
  $multiSupervisorText = Get-Content -LiteralPath $junkMultiSupervisorPath -Raw
  if ($multiSupervisorText -notmatch '--execute-simulate' -or $multiSupervisorText -match '--execute-real') {
    throw 'run-junk-multi.ps1 is not locked to --execute-simulate.'
  }
  $flowHeatmapSupervisorText = Get-Content -LiteralPath $junkFlowHeatmapSupervisorPath -Raw
  if ($flowHeatmapSupervisorText -notmatch '--execute-simulate' -or $flowHeatmapSupervisorText -match '--execute-real') {
    throw 'run-junk-flow-heatmap.ps1 is not locked to --execute-simulate.'
  }
}

function Resolve-OpenDExecutable {
  param([string]$ExplicitPath)

  $candidates = [System.Collections.Generic.List[string]]::new()
  $programFilesX86OpenD = $null
  if (${env:ProgramFiles(x86)}) {
    $programFilesX86OpenD = Join-Path ${env:ProgramFiles(x86)} 'moomoo OpenD\moomoo_OpenD.exe'
  }
  foreach ($candidate in @(
    $ExplicitPath,
    $env:MOOMOO_OPEND_EXE,
    (Join-Path $env:APPDATA 'moomoo_OpenD\moomoo_OpenD.exe'),
    (Join-Path $env:LOCALAPPDATA 'moomoo_OpenD\moomoo_OpenD.exe'),
    (Join-Path $env:ProgramFiles 'moomoo OpenD\moomoo_OpenD.exe'),
    $programFilesX86OpenD
  )) {
    if ($candidate) { $candidates.Add([string]$candidate) }
  }

  foreach ($process in @(Get-Process -Name 'moomoo_OpenD' -ErrorAction SilentlyContinue)) {
    try {
      if ($process.Path) { $candidates.Add([string]$process.Path) }
    } catch { }
  }

  foreach ($candidate in @($candidates | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  $registryRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($item in @(Get-ItemProperty -Path $registryRoots -ErrorAction SilentlyContinue)) {
    if ([string]$item.DisplayName -notmatch '(?i)moomoo.*OpenD|OpenD.*moomoo') { continue }
    $iconPath = ([string]$item.DisplayIcon).Trim().Trim('"').Split(',')[0]
    $installCandidate = $null
    if (-not [string]::IsNullOrWhiteSpace([string]$item.InstallLocation)) {
      $installCandidate = Join-Path ([string]$item.InstallLocation) 'moomoo_OpenD.exe'
    }
    foreach ($candidate in @($iconPath, $installCandidate)) {
      if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        return (Resolve-Path -LiteralPath $candidate).Path
      }
    }
  }

  throw 'moomoo_OpenD.exe was not found. Pass -OpenDPath or set MOOMOO_OPEND_EXE.'
}

function Get-RepositoryProcesses {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CommandLineToken,

    [string[]]$ProcessNames = @('powershell.exe', 'pwsh.exe', 'node.exe'),

    [string]$ExactPowerShellFilePath = ''
  )

  $matches = @()
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    if ($ProcessNames -notcontains [string]$process.Name) { continue }
    $commandLine = [string]$process.CommandLine
    if ($commandLine.IndexOf($CommandLineToken, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    if (-not [string]::IsNullOrWhiteSpace($ExactPowerShellFilePath)) {
      $fileMatch = [regex]::Match(
        $commandLine,
        '(?i)(?:^|\s)-File(?:\s+|:)(?:"([^"]+)"|''([^'']+)''|(\S+))'
      )
      if (-not $fileMatch.Success) { continue }
      $fileArgument = @($fileMatch.Groups[1].Value, $fileMatch.Groups[2].Value, $fileMatch.Groups[3].Value) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Select-Object -First 1
      try {
        $resolvedArgument = [IO.Path]::GetFullPath([string]$fileArgument)
        $resolvedExpected = [IO.Path]::GetFullPath($ExactPowerShellFilePath)
      } catch {
        continue
      }
      if (-not $resolvedArgument.Equals($resolvedExpected, [StringComparison]::OrdinalIgnoreCase)) { continue }
    }
    $matches += $process
  }
  return @($matches)
}

function Start-OpenD {
  param([Parameter(Mandatory = $true)][string]$ExecutablePath)

  Write-StackLog -Message 'Starting moomoo OpenD.'
  $null = Start-Process `
    -FilePath $ExecutablePath `
    -WorkingDirectory (Split-Path -Parent $ExecutablePath) `
    -WindowStyle Minimized `
    -PassThru
}

function Ensure-OpenD {
  param([Parameter(Mandatory = $true)][string]$ExecutablePath)

  if (Test-LocalTcpPort -Port $OpenDPort) {
    $script:openDDownChecks = 0
    Set-ComponentState -Name 'opend' -State 'healthy' -Detail "tcp_port=$OpenDPort"
    return $true
  }

  $script:lastMoomooApiHealthy = $false
  $script:lastMoomooProbeAt = [DateTimeOffset]::MinValue
  $processes = @(Get-Process -Name 'moomoo_OpenD' -ErrorAction SilentlyContinue)
  if ($processes.Count -eq 0) {
    $script:openDDownChecks = 0
    Start-OpenD -ExecutablePath $ExecutablePath
  } else {
    $script:openDDownChecks += 1
    if ($script:openDDownChecks -lt $OpenDStallRestartChecks) {
      Set-ComponentState `
        -Name 'opend' `
        -State 'starting_or_stalled' `
        -Detail "process_count=$($processes.Count); tcp_port=$OpenDPort unavailable; check=$($script:openDDownChecks)/$OpenDStallRestartChecks" `
        -Level 'WARN'
      return $false
    }

    Write-StackLog -Level 'WARN' -Message "OpenD remained unavailable for $OpenDStallRestartChecks checks; restarting its exact process name."
    foreach ($process in $processes) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 3
    $script:openDDownChecks = 0
    Start-OpenD -ExecutablePath $ExecutablePath
  }

  if (Wait-LocalTcpPort -Port $OpenDPort -TimeoutSeconds $StartupTimeoutSeconds) {
    Set-ComponentState -Name 'opend' -State 'healthy' -Detail "tcp_port=$OpenDPort"
    return $true
  }

  $script:openDDownChecks = 1
  Set-ComponentState `
    -Name 'opend' `
    -State 'unavailable' `
    -Detail "tcp_port=$OpenDPort did not open within $StartupTimeoutSeconds seconds" `
    -Level 'ERROR'
  return $false
}

function Get-ConsoleStatus {
  try {
    $status = Invoke-RestMethod `
      -Method Get `
      -Uri "http://127.0.0.1:$ConsolePort/api/status" `
      -TimeoutSec 5 `
      -ErrorAction Stop
    if ($status.server.scope -ne 'junkman_only') { return $null }
    return $status
  } catch {
    return $null
  }
}

function Invoke-ConsoleAction {
  param([Parameter(Mandatory = $true)][string]$Action)

  $allowedActions = @(
    'start-all',
    'start-browser',
    'start-capture',
    'stop-capture',
    'moomoo-check'
  )
  if ($allowedActions -notcontains $Action) {
    throw "Unsupported control-console action: $Action"
  }
  return Invoke-RestMethod `
    -Method Post `
    -Uri "http://127.0.0.1:$ConsolePort/api/$Action" `
    -ContentType 'application/json' `
    -Body '{}' `
    -TimeoutSec 10 `
    -ErrorAction Stop
}

function Start-ControlConsole {
  param([Parameter(Mandatory = $true)][string]$NodePath)

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdoutPath = Join-Path $logDirectory "control-console-stack-$stamp.stdout.log"
  $stderrPath = Join-Path $logDirectory "control-console-stack-$stamp.stderr.log"
  Write-StackLog -Message 'Starting the JUNKMAN control console.'
  $null = Start-Process `
    -FilePath $NodePath `
    -ArgumentList ('"{0}"' -f $consoleScriptPath) `
    -WorkingDirectory $rootPath `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
}

function Ensure-ControlConsole {
  param([Parameter(Mandatory = $true)][string]$NodePath)

  $status = Get-ConsoleStatus
  if ($null -ne $status) {
    $script:consoleUnhealthyChecks = 0
    Set-ComponentState -Name 'console' -State 'healthy' -Detail "http_port=$ConsolePort; scope=junkman_only"
    return $status
  }

  $portOccupied = Test-LocalTcpPort -Port $ConsolePort
  $repositoryConsoles = @(
    Get-RepositoryProcesses `
      -CommandLineToken 'apps\control-console\control-console.mjs' `
      -ProcessNames @('node.exe')
  )

  if ($repositoryConsoles.Count -gt 0) {
    $script:consoleUnhealthyChecks += 1
    if ($script:consoleUnhealthyChecks -lt $ConsoleStallRestartChecks) {
      Set-ComponentState `
        -Name 'console' `
        -State 'repository_process_unresponsive' `
        -Detail "process_count=$($repositoryConsoles.Count); api_unavailable=true; check=$($script:consoleUnhealthyChecks)/$ConsoleStallRestartChecks" `
        -Level 'WARN'
      return $null
    }

    Write-StackLog `
      -Level 'WARN' `
      -Message "The repository control console failed $ConsoleStallRestartChecks consecutive health checks; restarting only its verified process(es)."
    foreach ($process in $repositoryConsoles) {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    $script:consoleUnhealthyChecks = 0
    if (-not (Wait-LocalTcpPortClosed -Port $ConsolePort -TimeoutSeconds 10)) {
      Set-ComponentState `
        -Name 'console' `
        -State 'port_still_occupied' `
        -Detail "verified repository process stopped but tcp_port=$ConsolePort remained occupied; refusing to kill an unknown owner" `
        -Level 'ERROR'
      return $null
    }
    $portOccupied = $false
  } elseif ($portOccupied) {
    $script:consoleUnhealthyChecks = 0
    Set-ComponentState `
      -Name 'console' `
      -State 'foreign_port_owner' `
      -Detail "tcp_port=$ConsolePort is occupied without a verified repository console process; refusing to restart it" `
      -Level 'ERROR'
    return $null
  }

  $script:consoleUnhealthyChecks = 0
  Start-ControlConsole -NodePath $NodePath
  if (-not (Wait-LocalTcpPort -Port $ConsolePort -TimeoutSeconds 30)) {
    Set-ComponentState `
      -Name 'console' `
      -State 'unavailable' `
      -Detail "http_port=$ConsolePort did not open within 30 seconds" `
      -Level 'ERROR'
    return $null
  }

  $status = Get-ConsoleStatus
  if ($null -eq $status) {
    Set-ComponentState `
      -Name 'console' `
      -State 'invalid_response' `
      -Detail 'the local endpoint did not identify itself as scope=junkman_only' `
      -Level 'ERROR'
    return $null
  }

  Set-ComponentState -Name 'console' -State 'healthy' -Detail "http_port=$ConsolePort; scope=junkman_only"
  return $status
}

function Wait-ConsoleCaptureStopped {
  $deadline = (Get-Date).AddSeconds(10)
  do {
    Start-Sleep -Seconds 1
    $status = Get-ConsoleStatus
    if ($null -eq $status -or -not (Test-ConsoleCaptureRunning -ConsoleStatus $status)) { return }
  } while ((Get-Date) -lt $deadline)
}

function Test-ConsoleCaptureRunning {
  param([Parameter(Mandatory = $true)]$ConsoleStatus)

  if ($null -eq $ConsoleStatus.processes) { return $false }
  $captureProperty = $ConsoleStatus.processes.PSObject.Properties['capture']
  if ($null -eq $captureProperty -or $null -eq $captureProperty.Value) { return $false }
  return [bool]$captureProperty.Value.running
}

function Ensure-CaptureEnvironment {
  param([Parameter(Mandatory = $true)]$ConsoleStatus)

  $cdpWasDownThisCycle = -not (Test-LocalTcpPort -Port $CdpPort)
  $cdpHealthy = -not $cdpWasDownThisCycle
  if (-not $cdpHealthy) {
    Write-StackLog -Level 'WARN' -Message "CDP port $CdpPort is unavailable; asking the control console to start the Discord browser."
    $null = Invoke-ConsoleAction -Action 'start-browser'
    $cdpHealthy = Wait-LocalTcpPort -Port $CdpPort -TimeoutSeconds 45
  }

  if (-not $cdpHealthy) {
    $script:lastCdpHealthy = $false
    Set-ComponentState `
      -Name 'discord_cdp' `
      -State 'unavailable' `
      -Detail "tcp_port=$CdpPort did not open" `
      -Level 'ERROR'
    return $false
  }
  Set-ComponentState -Name 'discord_cdp' -State 'healthy' -Detail "tcp_port=$CdpPort"

  $status = Get-ConsoleStatus
  if ($null -eq $status) { $status = $ConsoleStatus }
  $captureRunning = Test-ConsoleCaptureRunning -ConsoleStatus $status
  $browserRecovered = $cdpWasDownThisCycle -or $script:lastCdpHealthy -eq $false

  if ($captureRunning -and $browserRecovered) {
    Write-StackLog -Level 'WARN' -Message 'Discord CDP recovered; restarting the console-owned capture so it reattaches to the browser.'
    $null = Invoke-ConsoleAction -Action 'stop-capture'
    Wait-ConsoleCaptureStopped
    $captureRunning = $false
  }

  if (-not $captureRunning) {
    $orphanCaptures = @(
      Get-RepositoryProcesses `
        -CommandLineToken 'apps\discord-capture\capture-discord.js' `
        -ProcessNames @('node.exe')
    )
    if ($orphanCaptures.Count -gt 0) {
      Write-StackLog -Level 'WARN' -Message "Replacing $($orphanCaptures.Count) orphaned repository capture process(es) with a console-owned capture."
      foreach ($process in $orphanCaptures) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
      }
      Start-Sleep -Seconds 2
    }
    Write-StackLog -Message 'Asking the control console to start Discord flow capture.'
    $null = Invoke-ConsoleAction -Action 'start-capture'
    Start-Sleep -Seconds 3
    $status = Get-ConsoleStatus
    $captureRunning = $null -ne $status -and (Test-ConsoleCaptureRunning -ConsoleStatus $status)
  }

  $script:lastCdpHealthy = $true
  if ($captureRunning) {
    Set-ComponentState -Name 'discord_capture' -State 'healthy' -Detail 'console_owned_process=running'
    return $true
  }

  Set-ComponentState `
    -Name 'discord_capture' `
    -State 'unavailable' `
    -Detail 'the control console could not keep the capture process running' `
    -Level 'ERROR'
  return $false
}

function Test-ExactJunkWatcherProcess {
  param([Parameter(Mandatory = $true)]$Process)

  if ([string]$Process.Name -ine 'node.exe') { return $false }

  $commandLine = [string]$Process.CommandLine
  if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }
  if ($commandLine -notmatch '(?i)(?:^|\s)--watch(?:\s|$)') { return $false }
  if ($commandLine -notmatch '(?i)(?:^|\s)--execute-simulate(?:\s|$)') { return $false }
  if ($commandLine -match '(?i)(?:^|\s)--execute-real(?:\s|$)') { return $false }

  $expectedScriptPath = Join-Path $rootPath 'apps\zero-dte-options\zero-dte-line.mjs'
  $expectedFullPath = [IO.Path]::GetFullPath($expectedScriptPath)
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
      $candidateFullPath = [IO.Path]::GetFullPath([string]$candidate)
    } catch {
      continue
    }
    if ($candidateFullPath.Equals($expectedFullPath, [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Get-VerifiedJunkWatcherProcesses {
  $matches = @()
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    if (Test-ExactJunkWatcherProcess -Process $process) { $matches += $process }
  }
  return @($matches)
}

function Get-JunkWatcherStatusAssessment {
  param(
    [Parameter(Mandatory = $true)]$Status,

    [ValidateRange(15, 300)]
    [int]$MaxAgeSeconds = 60
  )

  $processIdProperty = $Status.PSObject.Properties['process_id']
  $statusProcessId = 0
  $processIdValid = (
    $null -ne $processIdProperty -and
    [int]::TryParse([string]$processIdProperty.Value, [ref]$statusProcessId) -and
    $statusProcessId -gt 0
  )

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
  $ageSeconds = if ($timestampValid) {
    ([DateTimeOffset]::UtcNow - $updatedAt.ToUniversalTime()).TotalSeconds
  } else {
    [double]::PositiveInfinity
  }
  # A small future tolerance avoids recycling a healthy watcher during a minor
  # clock correction. A far-future timestamp must not make a frozen heartbeat
  # look perpetually fresh.
  $fresh = $timestampValid -and $ageSeconds -ge -5 -and $ageSeconds -le $MaxAgeSeconds

  $activeOrdersProperty = $Status.PSObject.Properties['active_orders']
  $activeOrdersKnown = $null -ne $activeOrdersProperty
  $activeOrderCount = 0
  if ($activeOrdersKnown) {
    $activeOrdersValue = $activeOrdersProperty.Value
    if ($null -eq $activeOrdersValue) {
      $activeOrderCount = 0
    } elseif ($activeOrdersValue -is [string] -or $activeOrdersValue -is [bool]) {
      $activeOrdersKnown = $false
    } elseif ($activeOrdersValue -is [ValueType]) {
      $activeOrdersKnown = (
        [int]::TryParse([string]$activeOrdersValue, [ref]$activeOrderCount) -and
        $activeOrderCount -ge 0
      )
    } elseif ($activeOrdersValue -is [System.Management.Automation.PSCustomObject]) {
      $activeOrderCount = 1
    } else {
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

  return [pscustomobject]@{
    ProcessId = $statusProcessId
    ProcessIdValid = $processIdValid
    ContractValid = $modeValid -and $realTradingFlagValid
    TimestampValid = $timestampValid
    AgeSeconds = $ageSeconds
    Fresh = $fresh
    ExposureKnown = $activeOrdersKnown -and $openPositionCountKnown
    ActiveOrderCount = $activeOrderCount
    OpenPositionCount = $openPositionCount
  }
}

function Test-JunkWatcherRunning {
  param(
    [ValidateRange(15, 300)]
    [int]$MaxAgeSeconds = $WatcherStatusMaxAgeSeconds
  )

  $script:junkWatcherRequiresSupervisorRemoval = $false
  $statusPath = Join-Path $logDirectory 'zero-dte-options-status.json'
  $verifiedProcesses = @(Get-VerifiedJunkWatcherProcesses)
  if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) {
    if ($verifiedProcesses.Count -gt 0) {
      $script:junkWatcherRequiresSupervisorRemoval = $true
      Set-ComponentState `
        -Name 'junk_watcher' `
        -State 'status_missing_preserved' `
        -Detail "verified_process_count=$($verifiedProcesses.Count); exposure_unknown=true; no_process_stopped=true" `
        -Level 'ERROR'
      return $true
    }
    return $false
  }

  try {
    $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
    $assessment = Get-JunkWatcherStatusAssessment -Status $status -MaxAgeSeconds $MaxAgeSeconds
  } catch {
    if ($verifiedProcesses.Count -gt 0) {
      $script:junkWatcherRequiresSupervisorRemoval = $true
      Set-ComponentState `
        -Name 'junk_watcher' `
        -State 'status_unreadable_preserved' `
        -Detail "verified_process_count=$($verifiedProcesses.Count); exposure_unknown=true; no_process_stopped=true" `
        -Level 'ERROR'
      return $true
    }
    return $false
  }

  $matchingProcesses = @(
    $verifiedProcesses | Where-Object {
      $assessment.ProcessIdValid -and [int]$_.ProcessId -eq $assessment.ProcessId
    }
  )
  if ($matchingProcesses.Count -ne 1 -or $verifiedProcesses.Count -ne 1) {
    if ($verifiedProcesses.Count -gt 0) {
      $script:junkWatcherRequiresSupervisorRemoval = $true
      Set-ComponentState `
        -Name 'junk_watcher' `
        -State 'process_identity_ambiguous_preserved' `
        -Detail "verified_process_count=$($verifiedProcesses.Count); status_pid_match_count=$($matchingProcesses.Count); no_process_stopped=true" `
        -Level 'ERROR'
      return $true
    }
    return $false
  }

  if (-not $assessment.ContractValid) {
    $script:junkWatcherRequiresSupervisorRemoval = $true
    Set-ComponentState `
      -Name 'junk_watcher' `
      -State 'simulation_contract_invalid_preserved' `
      -Detail 'mode_or_real_trading_flag_invalid=true; no_process_stopped=true' `
      -Level 'ERROR'
    return $true
  }

  if ($assessment.Fresh) {
    Set-ComponentState `
      -Name 'junk_watcher' `
      -State 'healthy' `
      -Detail "pid=$($assessment.ProcessId); status_age_seconds=$([Math]::Round([Math]::Max(0, $assessment.AgeSeconds), 1)); mode=execute_simulate; real_trading_allowed=false"
    return $true
  }

  if (-not $assessment.ExposureKnown) {
    $script:junkWatcherRequiresSupervisorRemoval = $true
    Set-ComponentState `
      -Name 'junk_watcher' `
      -State 'stale_exposure_unknown_preserved' `
      -Detail 'heartbeat_fresh=false; active_orders_or_open_position_count_unknown=true; no_process_stopped=true' `
      -Level 'ERROR'
    return $true
  }

  if ($assessment.ActiveOrderCount -gt 0 -or $assessment.OpenPositionCount -gt 0) {
    $script:junkWatcherRequiresSupervisorRemoval = $true
    Set-ComponentState `
      -Name 'junk_watcher' `
      -State 'stale_with_exposure_preserved' `
      -Detail "heartbeat_fresh=false; active_orders=$($assessment.ActiveOrderCount); open_position_count=$($assessment.OpenPositionCount); no_process_stopped=true" `
      -Level 'ERROR'
    return $true
  }

  # Re-read both the atomically-written status and exact process identity just
  # before stopping. This closes the window where a fresh heartbeat or PID reuse
  # could otherwise turn a safe stale-process recycle into an unsafe kill.
  try {
    $latestStatus = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
    $latestAssessment = Get-JunkWatcherStatusAssessment `
      -Status $latestStatus `
      -MaxAgeSeconds $MaxAgeSeconds
  } catch {
    $script:junkWatcherRequiresSupervisorRemoval = $true
    Set-ComponentState `
      -Name 'junk_watcher' `
      -State 'stale_recheck_failed_preserved' `
      -Detail 'status_recheck_failed=true; no_process_stopped=true' `
      -Level 'ERROR'
    return $true
  }

  if (
    -not $latestAssessment.ProcessIdValid -or
    $latestAssessment.ProcessId -ne $assessment.ProcessId -or
    -not $latestAssessment.ContractValid -or
    -not $latestAssessment.ExposureKnown -or
    $latestAssessment.ActiveOrderCount -gt 0 -or
    $latestAssessment.OpenPositionCount -gt 0
  ) {
    $script:junkWatcherRequiresSupervisorRemoval = $true
    Set-ComponentState `
      -Name 'junk_watcher' `
      -State 'stale_recheck_unsafe_preserved' `
      -Detail 'status_or_exposure_changed_before_recycle=true; no_process_stopped=true' `
      -Level 'ERROR'
    return $true
  }
  if ($latestAssessment.Fresh) {
    Set-ComponentState `
      -Name 'junk_watcher' `
      -State 'healthy_after_recheck' `
      -Detail "pid=$($latestAssessment.ProcessId); heartbeat_recovered_before_recycle=true"
    return $true
  }

  $processRecheck = @(
    Get-CimInstance `
      Win32_Process `
      -Filter "ProcessId = $($assessment.ProcessId)" `
      -ErrorAction SilentlyContinue
  )
  if (
    $processRecheck.Count -ne 1 -or
    -not (Test-ExactJunkWatcherProcess -Process $processRecheck[0])
  ) {
    Set-ComponentState `
      -Name 'junk_watcher' `
      -State 'stale_process_recheck_refused' `
      -Detail 'exact_repository_process_identity_not_confirmed=true; no_process_stopped=true' `
      -Level 'ERROR'
    return $false
  }

  Write-StackLog `
    -Level 'WARN' `
    -Message "Recycling stale zero-exposure JUNKMAN watcher pid=$($assessment.ProcessId); exact repository process identity was re-verified."
  try {
    Stop-Process -Id $assessment.ProcessId -Force -ErrorAction Stop
  } catch {
    $script:junkWatcherRequiresSupervisorRemoval = $true
    Set-ComponentState `
      -Name 'junk_watcher' `
      -State 'stale_recycle_failed_preserved' `
      -Detail "pid=$($assessment.ProcessId); stop_failed=true; no_replacement_allowed=true" `
      -Level 'ERROR'
    return $true
  }

  try {
    $remainingProcess = @(
      Get-CimInstance `
        Win32_Process `
        -Filter "ProcessId = $($assessment.ProcessId)" `
        -ErrorAction Stop
    )
  } catch {
    $script:junkWatcherRequiresSupervisorRemoval = $true
    Set-ComponentState `
      -Name 'junk_watcher' `
      -State 'stale_recycle_unconfirmed_preserved' `
      -Detail "pid=$($assessment.ProcessId); process_exit_query_failed=true; no_replacement_allowed=true" `
      -Level 'ERROR'
    return $true
  }
  if (@($remainingProcess | Where-Object { Test-ExactJunkWatcherProcess -Process $_ }).Count -gt 0) {
    $script:junkWatcherRequiresSupervisorRemoval = $true
    Set-ComponentState `
      -Name 'junk_watcher' `
      -State 'stale_recycle_unconfirmed_preserved' `
      -Detail "pid=$($assessment.ProcessId); exact_process_still_present=true; no_replacement_allowed=true" `
      -Level 'ERROR'
    return $true
  }

  Set-ComponentState `
    -Name 'junk_watcher' `
    -State 'stale_zero_exposure_recycled' `
    -Detail "pid=$($assessment.ProcessId); active_orders=0; open_position_count=0; top_level_recovery_allowed=true" `
    -Level 'WARN'
  return $false
}

function Start-JunkSupervisor {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdoutPath = Join-Path $logDirectory "junk-supervisor-stack-$stamp.stdout.log"
  $stderrPath = Join-Path $logDirectory "junk-supervisor-stack-$stamp.stderr.log"
  Write-StackLog -Message 'Starting the simulation-only JUNKMAN strategy supervisor.'
  Remove-Item Env:MOOMOO_OPEND_WS_KEY -ErrorAction SilentlyContinue
  $null = Start-Process `
    -FilePath $powershellPath `
    -ArgumentList @(
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      ('"{0}"' -f $junkSupervisorPath)
    ) `
    -WorkingDirectory $rootPath `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
}

function Ensure-JunkSupervisor {
  Assert-SimulationOnlyConfiguration

  # Always assess the child heartbeat, even while its restart supervisor is
  # present. A verified stale zero-exposure child can then be recycled and the
  # existing supervisor will safely recreate it.
  $watcherRunning = Test-JunkWatcherRunning

  $supervisors = @(
    Get-RepositoryProcesses `
      -CommandLineToken 'run-junk-gex.ps1' `
      -ProcessNames @('powershell.exe', 'pwsh.exe') `
      -ExactPowerShellFilePath $junkSupervisorPath
  )
  if ($script:junkWatcherRequiresSupervisorRemoval -and $supervisors.Count -gt 0) {
    Write-StackLog `
      -Level 'WARN' `
      -Message "Stopping $($supervisors.Count) exact JUNKMAN child supervisor process(es) so a protected watcher is not killed or duplicated."
    foreach ($supervisor in $supervisors) {
      Stop-Process -Id $supervisor.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Set-ComponentState `
      -Name 'junk_supervisor' `
      -State 'protected_watcher_supervisor_removed' `
      -Detail 'watcher_preserved=true; restart_authority_removed=true; no_duplicate_runtime=true' `
      -Level 'WARN'
    return $true
  }
  if ($supervisors.Count -gt 0) {
    Set-ComponentState -Name 'junk_supervisor' -State 'healthy' -Detail "process_count=$($supervisors.Count); mode=simulate_only"
    return $true
  }

  if ($watcherRunning) {
    Set-ComponentState `
      -Name 'junk_supervisor' `
      -State 'orphan_watcher' `
      -Detail 'a watcher is still running; deferring supervisor launch to avoid a duplicate runtime' `
      -Level 'WARN'
    return $true
  }

  Start-JunkSupervisor
  Start-Sleep -Seconds 5
  $supervisors = @(
    Get-RepositoryProcesses `
      -CommandLineToken 'run-junk-gex.ps1' `
      -ProcessNames @('powershell.exe', 'pwsh.exe') `
      -ExactPowerShellFilePath $junkSupervisorPath
  )
  if ($supervisors.Count -gt 0 -or (Test-JunkWatcherRunning)) {
    Set-ComponentState -Name 'junk_supervisor' -State 'healthy' -Detail 'mode=simulate_only; launch_confirmed=true'
    return $true
  }

  Set-ComponentState `
    -Name 'junk_supervisor' `
    -State 'unavailable' `
    -Detail 'the supervisor and watcher were not observed after launch' `
    -Level 'ERROR'
  return $false
}

function Start-JunkMultiSupervisor {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdoutPath = Join-Path $logDirectory "junk-multi-supervisor-stack-$stamp.stdout.log"
  $stderrPath = Join-Path $logDirectory "junk-multi-supervisor-stack-$stamp.stderr.log"
  Write-StackLog -Message 'Starting the simulation-only JUNKMAN-MULTI strategy supervisor.'
  $null = Start-Process `
    -FilePath $powershellPath `
    -ArgumentList @(
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      ('"{0}"' -f $junkMultiSupervisorPath)
    ) `
    -WorkingDirectory $rootPath `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
}

function Ensure-JunkMultiSupervisor {
  Assert-SimulationOnlyConfiguration
  $supervisors = @(
    Get-RepositoryProcesses `
      -CommandLineToken 'run-junk-multi.ps1' `
      -ProcessNames @('powershell.exe', 'pwsh.exe') `
      -ExactPowerShellFilePath $junkMultiSupervisorPath
  )
  if ($supervisors.Count -gt 0) {
    Set-ComponentState -Name 'junk_multi_supervisor' -State 'healthy' -Detail "process_count=$($supervisors.Count); mode=simulate_only"
    return $true
  }
  $watchers = @(
    Get-RepositoryProcesses `
      -CommandLineToken 'apps\junk-multi-options\junk-multi-line.mjs' `
      -ProcessNames @('node.exe')
  )
  if ($watchers.Count -gt 0) {
    Set-ComponentState `
      -Name 'junk_multi_supervisor' `
      -State 'orphan_watcher' `
      -Detail 'a watcher is running; deferring supervisor launch to avoid a duplicate runtime' `
      -Level 'WARN'
    return $true
  }
  Start-JunkMultiSupervisor
  Start-Sleep -Seconds 3
  $supervisors = @(
    Get-RepositoryProcesses `
      -CommandLineToken 'run-junk-multi.ps1' `
      -ProcessNames @('powershell.exe', 'pwsh.exe') `
      -ExactPowerShellFilePath $junkMultiSupervisorPath
  )
  if ($supervisors.Count -lt 1) {
    Set-ComponentState -Name 'junk_multi_supervisor' -State 'unavailable' -Detail 'launch_not_observed' -Level 'ERROR'
    return $false
  }
  Set-ComponentState -Name 'junk_multi_supervisor' -State 'healthy' -Detail 'mode=simulate_only; launch_confirmed=true'
  return $true
}

function Start-JunkFlowHeatmapSupervisor {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdoutPath = Join-Path $logDirectory "junk-flow-heatmap-supervisor-stack-$stamp.stdout.log"
  $stderrPath = Join-Path $logDirectory "junk-flow-heatmap-supervisor-stack-$stamp.stderr.log"
  Write-StackLog -Message 'Starting the simulation-only JUNKMAN-FLOW-HEATMAP strategy supervisor.'
  $null = Start-Process `
    -FilePath $powershellPath `
    -ArgumentList @(
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      ('"{0}"' -f $junkFlowHeatmapSupervisorPath)
    ) `
    -WorkingDirectory $rootPath `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
}

function Ensure-JunkFlowHeatmapSupervisor {
  Assert-SimulationOnlyConfiguration
  $supervisors = @(
    Get-RepositoryProcesses `
      -CommandLineToken 'run-junk-flow-heatmap.ps1' `
      -ProcessNames @('powershell.exe', 'pwsh.exe') `
      -ExactPowerShellFilePath $junkFlowHeatmapSupervisorPath
  )
  if ($supervisors.Count -gt 0) {
    Set-ComponentState -Name 'junk_flow_heatmap_supervisor' -State 'healthy' -Detail "process_count=$($supervisors.Count); mode=simulate_only"
    return $true
  }
  $watchers = @(
    Get-RepositoryProcesses `
      -CommandLineToken 'apps\junk-flow-heatmap-options\junk-flow-heatmap-line.mjs' `
      -ProcessNames @('node.exe')
  )
  if ($watchers.Count -gt 0) {
    Set-ComponentState `
      -Name 'junk_flow_heatmap_supervisor' `
      -State 'orphan_watcher' `
      -Detail 'a watcher is running; deferring supervisor launch to avoid a duplicate runtime' `
      -Level 'WARN'
    return $true
  }
  Start-JunkFlowHeatmapSupervisor
  Start-Sleep -Seconds 3
  $supervisors = @(
    Get-RepositoryProcesses `
      -CommandLineToken 'run-junk-flow-heatmap.ps1' `
      -ProcessNames @('powershell.exe', 'pwsh.exe') `
      -ExactPowerShellFilePath $junkFlowHeatmapSupervisorPath
  )
  if ($supervisors.Count -lt 1) {
    Set-ComponentState -Name 'junk_flow_heatmap_supervisor' -State 'unavailable' -Detail 'launch_not_observed' -Level 'ERROR'
    return $false
  }
  Set-ComponentState -Name 'junk_flow_heatmap_supervisor' -State 'healthy' -Detail 'mode=simulate_only; launch_confirmed=true'
  return $true
}

function Set-JunkApiGateState {
  $supervisors = @(
    Get-RepositoryProcesses `
      -CommandLineToken 'run-junk-gex.ps1' `
      -ProcessNames @('powershell.exe', 'pwsh.exe') `
      -ExactPowerShellFilePath $junkSupervisorPath
  )
  if ($supervisors.Count -gt 0) {
    # run-junk-gex.ps1 restarts its child independently. Remove only that restart
    # authority while the API gate is closed; its already-running Node watcher is
    # a separate process and is intentionally preserved to manage existing state.
    Write-StackLog `
      -Level 'WARN' `
      -Message "Moomoo API health is unavailable; stopping $($supervisors.Count) JUNKMAN restart supervisor process(es) while leaving any existing watcher running."
    foreach ($supervisor in $supervisors) {
      Stop-Process -Id $supervisor.ProcessId -Force -ErrorAction SilentlyContinue
    }
    $supervisors = @()
  }

  $multiSupervisors = @(
    Get-RepositoryProcesses `
      -CommandLineToken 'run-junk-multi.ps1' `
      -ProcessNames @('powershell.exe', 'pwsh.exe') `
      -ExactPowerShellFilePath $junkMultiSupervisorPath
  )
  if ($multiSupervisors.Count -gt 0) {
    Write-StackLog `
      -Level 'WARN' `
      -Message "Moomoo API health is unavailable; stopping $($multiSupervisors.Count) JUNKMAN-MULTI restart supervisor process(es) while leaving any existing watcher running."
    foreach ($supervisor in $multiSupervisors) {
      Stop-Process -Id $supervisor.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }

  $flowHeatmapSupervisors = @(
    Get-RepositoryProcesses `
      -CommandLineToken 'run-junk-flow-heatmap.ps1' `
      -ProcessNames @('powershell.exe', 'pwsh.exe') `
      -ExactPowerShellFilePath $junkFlowHeatmapSupervisorPath
  )
  if ($flowHeatmapSupervisors.Count -gt 0) {
    Write-StackLog `
      -Level 'WARN' `
      -Message "Moomoo API health is unavailable; stopping $($flowHeatmapSupervisors.Count) JUNKMAN-FLOW-HEATMAP restart supervisor process(es) while leaving any existing watcher running."
    foreach ($supervisor in $flowHeatmapSupervisors) {
      Stop-Process -Id $supervisor.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }

  # Remove restart authority before a stale child can be recycled. Otherwise the
  # child supervisor could race this closed API gate and launch a replacement.
  $watcherRunning = Test-JunkWatcherRunning

  if ($watcherRunning) {
    Set-ComponentState `
      -Name 'junk_supervisor' `
      -State 'api_unhealthy_existing_watcher_preserved' `
      -Detail 'restart_supervisor_count=0; watcher_running=true; no_new_runtime_started=true' `
      -Level 'WARN'
    return
  }

  Set-ComponentState `
    -Name 'junk_supervisor' `
    -State 'blocked_by_moomoo_api_health' `
    -Detail 'no_existing_runtime=true; no_new_runtime_started=true' `
    -Level 'ERROR'
}

try {
  Assert-SimulationOnlyConfiguration
  $nodePath = Resolve-NodePath
  $nodeDirectory = Split-Path -Parent $nodePath
  if (($env:PATH -split ';') -notcontains $nodeDirectory) {
    $env:PATH = "$nodeDirectory;$env:PATH"
  }
  # Even if this process inherited the User value at logon, keep the long-lived
  # stack supervisor secret-free. The key is injected only around the two child
  # launches that require it and is restored/cleared in finally blocks.
  Remove-Item Env:MOOMOO_OPEND_WS_KEY -ErrorAction SilentlyContinue
  $resolvedOpenDPath = Resolve-OpenDExecutable -ExplicitPath $OpenDPath

  Write-StackLog -Message 'JUNKMAN stack supervisor started; execution is locked to moomoo simulation.'
  Write-StackLog -Message ("Runtime dependencies resolved: node_version={0}; OpenD executable found." -f (Get-ExecutableNodeVersion -ExecutablePath $nodePath))
  Write-StackHeartbeat -Phase 'starting'
  while ($true) {
    Write-StackHeartbeat
    $openDHealthy = $false
    try {
      $openDHealthy = Ensure-OpenD -ExecutablePath $resolvedOpenDPath
    } catch {
      Set-ComponentState -Name 'opend' -State 'error' -Detail $_.Exception.Message -Level 'ERROR'
    }

    if ($openDHealthy) {
      $probeDue = (
        ([DateTimeOffset]::UtcNow - $script:lastMoomooProbeAt).TotalSeconds -ge
        $MoomooHealthProbeIntervalSeconds
      )
      if ($probeDue) {
        $script:lastMoomooProbeAt = [DateTimeOffset]::UtcNow
        $probeResult = Invoke-MoomooApiHealthProbe `
          -NodePath $nodePath `
          -TimeoutSeconds $MoomooHealthProbeTimeoutSeconds
        $script:lastMoomooApiHealthy = [bool]$probeResult.Healthy
        if ($script:lastMoomooApiHealthy) {
          $script:consecutiveMoomooApiFailures = 0
          Set-ComponentState `
            -Name 'moomoo_api' `
            -State 'healthy' `
            -Detail "fresh_check=true; qot=true; trd=true; simulate_us_options_account=true; checked_at=$($probeResult.CheckedAt.ToString('o'))"
        } else {
          $script:consecutiveMoomooApiFailures += 1
          Set-ComponentState `
            -Name 'moomoo_api' `
            -State 'unhealthy' `
            -Detail "reason=$($probeResult.Reason); OpenD_tcp_process_is_left_running=true" `
            -Level 'ERROR'

          # Close the start/restart gate immediately. Console and Discord health
          # work below must not delay protection after a probe timeout/failure.
          Set-JunkApiGateState

          $authRecoveryDue = (
            $script:consecutiveMoomooApiFailures -ge 3 -and
            (Test-MoomooProbeLooksLikeAuthenticationFailure) -and
            ([DateTimeOffset]::UtcNow - $script:lastOpenDAuthRecoveryAt).TotalSeconds -ge
              $OpenDAuthRecoveryCooldownSeconds
          )
          if ($authRecoveryDue) {
            $script:lastOpenDAuthRecoveryAt = [DateTimeOffset]::UtcNow
            $authRecoveryDeadline = [DateTimeOffset]::UtcNow.AddSeconds(
              $OpenDAuthRecoveryTimeoutSeconds
            )
            $recoverySeconds = [Math]::Max(
              1,
              [int][Math]::Floor(
                ($authRecoveryDeadline - [DateTimeOffset]::UtcNow).TotalSeconds
              )
            )
            $recovered = Invoke-OpenDAuthRecovery -TimeoutSeconds $recoverySeconds

            $validationSecondsRemaining = [int][Math]::Floor(
              ($authRecoveryDeadline - [DateTimeOffset]::UtcNow).TotalSeconds
            )
            if ($recovered -and $validationSecondsRemaining -gt 0) {
              $boundedValidationSeconds = [Math]::Min(
                $MoomooHealthProbeTimeoutSeconds,
                $validationSecondsRemaining
              )
              $probeResult = Invoke-MoomooApiHealthProbe `
                -NodePath $nodePath `
                -TimeoutSeconds $boundedValidationSeconds
              $script:lastMoomooApiHealthy = [bool]$probeResult.Healthy
            } else {
              $script:lastMoomooApiHealthy = $false
              if ($recovered) {
                $probeResult = [pscustomobject]@{
                  Healthy = $false
                  Reason = 'auth_recovery_validation_deadline_exhausted'
                  CheckedAt = $null
                }
              }
            }

            if ($script:lastMoomooApiHealthy) {
              $script:consecutiveMoomooApiFailures = 0
              Set-ComponentState `
                -Name 'moomoo_api' `
                -State 'healthy_after_local_auth_recovery' `
                -Detail "fresh_check=true; qot=true; trd=true; simulate_us_options_account=true; checked_at=$($probeResult.CheckedAt.ToString('o'))"
            } else {
              Set-ComponentState `
                -Name 'moomoo_api' `
                -State 'unhealthy_after_local_auth_recovery' `
                -Detail "reason=$($probeResult.Reason); credential_value_not_logged=true" `
                -Level 'ERROR'
              Set-JunkApiGateState
            }
          }
        }
      }
    } else {
      $script:lastMoomooApiHealthy = $false
      Set-ComponentState `
        -Name 'moomoo_api' `
        -State 'blocked_by_opend_tcp' `
        -Detail "tcp_port=$OpenDPort unavailable; probe_not_run=true" `
        -Level 'ERROR'
      Set-JunkApiGateState
    }

    $consoleStatus = $null
    try {
      $consoleStatus = Ensure-ControlConsole -NodePath $nodePath
    } catch {
      Set-ComponentState -Name 'console' -State 'error' -Detail $_.Exception.Message -Level 'ERROR'
    }

    if ($null -ne $consoleStatus) {
      try {
        $null = Ensure-CaptureEnvironment -ConsoleStatus $consoleStatus
      } catch {
        Set-ComponentState -Name 'discord_capture' -State 'error' -Detail $_.Exception.Message -Level 'ERROR'
      }
    }

    if ($script:lastMoomooApiHealthy) {
      try {
        $null = Ensure-JunkSupervisor
      } catch {
        Set-ComponentState -Name 'junk_supervisor' -State 'error' -Detail $_.Exception.Message -Level 'ERROR'
      }
      try {
        $null = Ensure-JunkMultiSupervisor
      } catch {
        Set-ComponentState -Name 'junk_multi_supervisor' -State 'error' -Detail $_.Exception.Message -Level 'ERROR'
      }
      try {
        $null = Ensure-JunkFlowHeatmapSupervisor
      } catch {
        Set-ComponentState -Name 'junk_flow_heatmap_supervisor' -State 'error' -Detail $_.Exception.Message -Level 'ERROR'
      }
    } else {
      Set-JunkApiGateState
    }

    Write-StackHeartbeat
    Start-Sleep -Seconds $CheckIntervalSeconds
  }
} finally {
  Write-StackHeartbeat -Phase 'stopping'
  try { Write-StackLog -Message 'JUNKMAN stack supervisor is stopping; child services are intentionally left running.' } catch { }
  try { $stackMutex.ReleaseMutex() } catch { }
  $stackMutex.Dispose()
}
