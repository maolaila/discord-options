param(
  [ValidateRange(5, 300)]
  [int]$CheckIntervalSeconds = 15,

  [ValidateRange(5, 300)]
  [int]$RestartDelaySeconds = 15
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot

$rootPath = $PSScriptRoot
$logDirectory = Join-Path $rootPath 'logs'
$policyPath = Join-Path $rootPath 'config\pa-options-policy.json'
$envPath = Join-Path $rootPath '.env'
$entryPath = Join-Path $rootPath 'apps\options-sim\moomoo-signal-trader.mjs'
$exitPath = Join-Path $rootPath 'apps\options-sim\moomoo-exit-monitor.mjs'
$exitStatusPath = Join-Path $logDirectory 'pa-options-exit-status.json'
$supervisorLogPath = Join-Path $logDirectory 'pa-options-supervisor.log'

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

$createdNew = $false
$mutex = [Threading.Mutex]::new($true, 'Local\DiscordOptionsPaOptionsSupervisor', [ref]$createdNew)
if (-not $createdNew) {
  $mutex.Dispose()
  Write-Output 'The PA options supervisor is already running in this Windows session.'
  exit 0
}

function Write-SupervisorLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  Add-Content -LiteralPath $supervisorLogPath -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
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

function Resolve-Node24Path {
  foreach ($command in @(Get-Command node -All -ErrorAction SilentlyContinue)) {
    try {
      $version = & $command.Source --version 2>$null
      if ($version -match '^v?(\d+)\.(\d+)\.(\d+)$' -and
          [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3]) -ge [version]'24.15.0') {
        return [string]$command.Source
      }
    } catch { }
  }
  throw 'Node.js 24.15 or newer was not found.'
}

function Assert-PaSimulationOnly {
  foreach ($requiredPath in @($envPath, $policyPath, $entryPath, $exitPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "Required PA simulation file is missing: $requiredPath"
    }
  }

  if (
    (Get-DotEnvValue -FilePath $envPath -Name 'MOOMOO_TRD_ENV') -ine 'simulate' -or
    (Get-DotEnvValue -FilePath $envPath -Name 'MOOMOO_ALLOW_REAL_TRADING') -ine 'false'
  ) {
    throw '.env is not explicitly locked to moomoo simulation.'
  }

  $policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
  if (
    $policy.business_line.id -ne 'pa-options' -or
    $policy.business_line.status -notin @('active', 'disabled') -or
    $policy.execution.environment -ne 'simulate_only' -or
    [bool]$policy.execution.real_trading_allowed
  ) {
    throw 'The PA options policy is not simulation-only.'
  }
}

function Get-PaPolicyStatus {
  $policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
  return [string]$policy.business_line.status
}

function Test-PaExitDrainComplete {
  if (-not (Test-Path -LiteralPath $exitStatusPath -PathType Leaf)) { return $false }
  try {
    $status = Get-Content -LiteralPath $exitStatusPath -Raw | ConvertFrom-Json
    $updatedAt = [DateTimeOffset]::Parse([string]$status.updated_at)
    $maximumAgeSeconds = [Math]::Max(120, $CheckIntervalSeconds * 4)
    if (([DateTimeOffset]::UtcNow - $updatedAt).TotalSeconds -gt $maximumAgeSeconds) { return $false }
    return (
      [string]$status.business_line -eq 'pa-options' -and
      [string]$status.phase -eq 'ok' -and
      -not [bool]$status.active_pa_position -and
      -not [bool]$status.unresolved_exit_submission -and
      [int]$status.watched -eq 0
    )
  } catch {
    return $false
  }
}

function Restore-DirectKey {
  param([bool]$WasPresent, [AllowNull()][string]$OriginalValue)
  if ($WasPresent) {
    $env:MOOMOO_OPEND_WS_KEY = [string]$OriginalValue
  } else {
    Remove-Item Env:MOOMOO_OPEND_WS_KEY -ErrorAction SilentlyContinue
  }
}

function Start-PaChild {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][int]$Attempt
  )

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdoutPath = Join-Path $logDirectory "pa-options-$Name-$stamp-$Attempt.stdout.log"
  $stderrPath = Join-Path $logDirectory "pa-options-$Name-$stamp-$Attempt.stderr.log"
  $originalKeyWasPresent = Test-Path Env:MOOMOO_OPEND_WS_KEY
  $originalKey = if ($originalKeyWasPresent) { [string]$env:MOOMOO_OPEND_WS_KEY } else { $null }
  $userKey = [Environment]::GetEnvironmentVariable('MOOMOO_OPEND_WS_KEY', 'User')
  $childArguments = @($ScriptPath) + $Arguments

  try {
    if (-not [string]::IsNullOrWhiteSpace($userKey)) {
      $env:MOOMOO_OPEND_WS_KEY = $userKey
    }
    $process = Start-Process `
      -FilePath $NodePath `
      -ArgumentList $childArguments `
      -WorkingDirectory $rootPath `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -PassThru
    Write-SupervisorLog "$Name started pid=$($process.Id) attempt=$Attempt mode=simulate_only"
    return $process
  } finally {
    Restore-DirectKey -WasPresent $originalKeyWasPresent -OriginalValue $originalKey
    $userKey = $null
    $originalKey = $null
  }
}

Assert-PaSimulationOnly
$nodePath = Resolve-Node24Path
$nodeDirectory = Split-Path -Parent $nodePath
if (($env:PATH -split ';') -notcontains $nodeDirectory) {
  $env:PATH = "$nodeDirectory;$env:PATH"
}
Remove-Item Env:MOOMOO_OPEND_WS_KEY -ErrorAction SilentlyContinue

$definitions = @{
  entry = @{
    ScriptPath = $entryPath
    Arguments = @(
      '--business-line', 'pa-options',
      '--policy-file', $policyPath,
      '--watch', '--execute-simulate'
    )
  }
  exit = @{
    ScriptPath = $exitPath
    Arguments = @(
      '--business-line', 'pa-options',
      '--policy-file', $policyPath,
      '--watch'
    )
  }
}
$children = @{}
$attempts = @{ entry = 0; exit = 0 }
$restartAfter = @{ entry = [DateTimeOffset]::MinValue; exit = [DateTimeOffset]::MinValue }
$lastLoggedPolicyStatus = $null

try {
  Write-SupervisorLog 'PA options supervisor started; simulation-only policy will choose active or exit-drain mode.'
  while ($true) {
    Assert-PaSimulationOnly
    $policyStatus = Get-PaPolicyStatus
    $desiredNames = if ($policyStatus -eq 'active') { @('entry', 'exit') } else { @('exit') }
    if ($policyStatus -ne $lastLoggedPolicyStatus) {
      $modeLabel = if ($policyStatus -eq 'active') { 'entry_and_exit' } else { 'exit_only_drain' }
      Write-SupervisorLog "PA policy status=$policyStatus; mode=$modeLabel"
      $lastLoggedPolicyStatus = $policyStatus
    }

    foreach ($name in @('entry', 'exit')) {
      if ($name -in $desiredNames) { continue }
      $child = $children[$name]
      if ($null -ne $child) {
        try {
          $child.Refresh()
          if (-not $child.HasExited) { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue }
          $child.Dispose()
        } catch { }
        $children.Remove($name)
        Write-SupervisorLog "$name stopped because PA policy status=$policyStatus"
      }
    }

    if ($policyStatus -eq 'disabled' -and (Test-PaExitDrainComplete)) {
      Write-SupervisorLog 'PA exit drain is complete; no position or unresolved exit remains. Supervisor will stop permanently.'
      break
    }

    foreach ($name in $desiredNames) {
      $child = $children[$name]
      if ($null -ne $child) {
        $liveChild = Get-Process -Id $child.Id -ErrorAction SilentlyContinue
        if ($null -ne $liveChild) { continue }
        Write-SupervisorLog "$name exited or disappeared; restart_delay_seconds=$RestartDelaySeconds"
        try { $child.Dispose() } catch { }
        $children.Remove($name)
        $restartAfter[$name] = [DateTimeOffset]::UtcNow.AddSeconds($RestartDelaySeconds)
      }

      if ([DateTimeOffset]::UtcNow -lt $restartAfter[$name]) { continue }
      $attempts[$name] += 1
      $definition = $definitions[$name]
      $children[$name] = Start-PaChild `
        -Name $name `
        -ScriptPath $definition.ScriptPath `
        -Arguments $definition.Arguments `
        -NodePath $nodePath `
        -Attempt $attempts[$name]
    }
    Start-Sleep -Seconds $CheckIntervalSeconds
  }
} finally {
  foreach ($child in @($children.Values)) {
    try {
      $child.Refresh()
      if (-not $child.HasExited) { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue }
      $child.Dispose()
    } catch { }
  }
  try { Write-SupervisorLog 'PA options supervisor stopped; owned children were stopped.' } catch { }
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
}
