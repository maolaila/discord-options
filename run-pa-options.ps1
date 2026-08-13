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

function Resolve-Node20Path {
  foreach ($command in @(Get-Command node -All -ErrorAction SilentlyContinue)) {
    try {
      $version = & $command.Source --version 2>$null
      if ($version -match '^v(\d+)' -and [int]$Matches[1] -ge 20) {
        return [string]$command.Source
      }
    } catch { }
  }
  throw 'Node.js 20 or newer was not found.'
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
    $policy.execution.environment -ne 'simulate_only' -or
    [bool]$policy.execution.real_trading_allowed
  ) {
    throw 'The PA options policy is not simulation-only.'
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
$nodePath = Resolve-Node20Path
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

try {
  Write-SupervisorLog 'PA options supervisor started; entry and exit are locked to simulation.'
  while ($true) {
    Assert-PaSimulationOnly
    foreach ($name in @('entry', 'exit')) {
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
