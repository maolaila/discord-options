import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stackScriptPath = path.join(repositoryRoot, 'run-junk-stack.ps1');
const runtimeContractFiles = [
  'run-junk-stack.ps1',
  'run-junk-gex.ps1',
  'run-pa-options.ps1',
  path.join('ops', 'recover-opend-websocket-auth.ps1'),
];
const powershellPath = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

function runPowerShell(source, extraEnv = {}) {
  return spawnSync(
    powershellPath,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, STACK_SCRIPT_PATH: stackScriptPath, ...extraEnv },
      input: source,
      timeout: 30_000,
    },
  );
}

test('run-junk-stack.ps1 passes the PowerShell parser', () => {
  const result = runPowerShell(String.raw`
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  $env:STACK_SCRIPT_PATH,
  [ref]$tokens,
  [ref]$errors
) | Out-Null
if ($errors.Count -gt 0) {
  $errors | ForEach-Object { Write-Error $_.Message }
  exit 1
}
`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('repository startup contract rejects runtimes older than Node 24.15', () => {
  const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));

  assert.equal(packageJson.engines?.node, '>=24.15.0');
  assert.equal(packageLock.packages?.['']?.engines?.node, packageJson.engines.node);
  for (const relativePath of runtimeContractFiles) {
    const source = readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
    assert.match(source, /24\.15\.0/, `${relativePath} does not enforce the Node runtime floor`);
    assert.doesNotMatch(source, /Node\.js 20 or newer/, `${relativePath} retains the obsolete Node 20 contract`);
  }
});

test('stack supervisor does not interfere with pending Windows shutdowns', () => {
  const source = readFileSync(stackScriptPath, 'utf8');
  assert.doesNotMatch(source, /Cancel-PendingWindowsShutdown/);
  assert.doesNotMatch(source, /shutdown\.exe[\s\S]*?\/a/);
});

test('JUNK watcher liveness is fresh-contract gated and stale recycling is exposure safe', () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'junk-stack-liveness-'));
  try {
    const result = runPowerShell(String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $env:STACK_SCRIPT_PATH,
  [ref]$tokens,
  [ref]$errors
)
if ($errors.Count -gt 0) { throw 'The source script did not parse.' }

$wantedFunctions = @(
  'Test-ExactJunkWatcherProcess',
  'Get-VerifiedJunkWatcherProcesses',
  'Get-JunkWatcherStatusAssessment',
  'Test-JunkWatcherRunning',
  'Ensure-JunkSupervisor'
)
$functionAsts = @($ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $wantedFunctions -contains $node.Name
}, $true))
if ($functionAsts.Count -ne $wantedFunctions.Count) {
  throw "Expected $($wantedFunctions.Count) liveness functions, found $($functionAsts.Count)."
}
foreach ($name in $wantedFunctions) {
  $definition = $functionAsts | Where-Object Name -eq $name | Select-Object -First 1
  Invoke-Expression $definition.Extent.Text
}

$rootPath = $env:TEST_STACK_ROOT
$logDirectory = Join-Path $rootPath 'logs'
$WatcherStatusMaxAgeSeconds = 60
$script:junkWatcherRequiresSupervisorRemoval = $false
$statusPath = Join-Path $logDirectory 'zero-dte-options-status.json'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$watcherScript = Join-Path $rootPath 'apps\zero-dte-options\zero-dte-line.mjs'
$script:RepoProcess = [pscustomobject]@{
  Name = 'node.exe'
  ProcessId = 4242
  CommandLine = '"C:\node\node.exe" "' + $watcherScript + '" --watch --execute-simulate'
}
$script:MockProcesses = @($script:RepoProcess)
$script:StoppedIds = @()
$script:States = @()
$script:LogMessages = @()
$script:StopShouldFail = $false

function Get-CimInstance {
  [CmdletBinding()]
  param(
    [Parameter(Position = 0)][string]$ClassName,
    [string]$Filter
  )
  $rows = @($script:MockProcesses)
  if (-not [string]::IsNullOrWhiteSpace($Filter) -and $Filter -match 'ProcessId\s*=\s*(\d+)') {
    $wantedId = [int]$Matches[1]
    $rows = @($rows | Where-Object { [int]$_.ProcessId -eq $wantedId })
  }
  return @($rows)
}

function Stop-Process {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][int]$Id,
    [switch]$Force
  )
  if ($script:StopShouldFail) { throw 'mock stop failure' }
  $script:StoppedIds += $Id
  $script:MockProcesses = @($script:MockProcesses | Where-Object { [int]$_.ProcessId -ne $Id })
}

function Set-ComponentState {
  param(
    [string]$Name,
    [string]$State,
    [string]$Detail,
    [string]$Level = 'INFO'
  )
  $script:States += [pscustomobject]@{
    Name = $Name
    State = $State
    Detail = $Detail
    Level = $Level
  }
}

function Write-StackLog {
  param([string]$Message, [string]$Level = 'INFO')
  $script:LogMessages += "$Level|$Message"
}

function Write-TestStatus {
  param([Parameter(Mandatory = $true)][hashtable]$Payload)
  $Payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding UTF8
}

function Reset-TestCase {
  $script:MockProcesses = @($script:RepoProcess)
  $script:StoppedIds = @()
  $script:States = @()
  $script:LogMessages = @()
  $script:StopShouldFail = $false
  $script:junkWatcherRequiresSupervisorRemoval = $false
}

function New-ValidStatus {
  param(
    [string]$UpdatedAt = ([DateTimeOffset]::UtcNow.ToString('o')),
    $ActiveOrders = @(),
    [int]$OpenPositionCount = 0
  )
  return @{
    process_id = 4242
    updated_at = $UpdatedAt
    mode = 'execute_simulate'
    real_trading_allowed = $false
    active_orders = $ActiveOrders
    risk = @{ open_position_count = $OpenPositionCount }
  }
}

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

function Assert-False([bool]$Value, [string]$Message) {
  if ($Value) { throw $Message }
}

function Assert-LastState([string]$Expected) {
  if ($script:States.Count -eq 0 -or $script:States[-1].State -ne $Expected) {
    $actual = if ($script:States.Count -eq 0) { '<none>' } else { $script:States[-1].State }
    throw "Expected state '$Expected', got '$actual'."
  }
}

# A valid, fresh, exact repository process is the only ordinary healthy case.
Reset-TestCase
Write-TestStatus (New-ValidStatus)
Assert-True (Test-JunkWatcherRunning -MaxAgeSeconds 60) 'Fresh watcher was not accepted.'
Assert-LastState 'healthy'
Assert-True ($script:StoppedIds.Count -eq 0) 'Fresh watcher was stopped.'

# The assessment itself rejects malformed/far-future timestamps and honors its
# configurable maximum age instead of trusting file presence alone.
$invalidTimestampStatus = New-ValidStatus -UpdatedAt 'not-a-timestamp'
$invalidTimestampObject = $invalidTimestampStatus | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$invalidTimestampAssessment = Get-JunkWatcherStatusAssessment -Status $invalidTimestampObject -MaxAgeSeconds 60
Assert-False $invalidTimestampAssessment.TimestampValid 'Malformed updated_at was parsed.'
Assert-False $invalidTimestampAssessment.Fresh 'Malformed updated_at was fresh.'

$futureTimestampStatus = New-ValidStatus -UpdatedAt ([DateTimeOffset]::UtcNow.AddMinutes(10).ToString('o'))
$futureTimestampObject = $futureTimestampStatus | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$futureTimestampAssessment = Get-JunkWatcherStatusAssessment -Status $futureTimestampObject -MaxAgeSeconds 60
Assert-True $futureTimestampAssessment.TimestampValid 'Future updated_at should still parse.'
Assert-False $futureTimestampAssessment.Fresh 'Far-future updated_at bypassed liveness.'

$ninetySecondStatus = New-ValidStatus -UpdatedAt ([DateTimeOffset]::UtcNow.AddSeconds(-90).ToString('o'))
$ninetySecondObject = $ninetySecondStatus | ConvertTo-Json -Depth 8 | ConvertFrom-Json
Assert-False (Get-JunkWatcherStatusAssessment -Status $ninetySecondObject -MaxAgeSeconds 60).Fresh '60-second threshold was not enforced.'
Assert-True (Get-JunkWatcherStatusAssessment -Status $ninetySecondObject -MaxAgeSeconds 120).Fresh 'Configurable threshold was ignored.'

# A stale watcher with explicit zero exposure is rechecked and recycled.
Reset-TestCase
Write-TestStatus (New-ValidStatus -UpdatedAt ([DateTimeOffset]::UtcNow.AddMinutes(-2).ToString('o')))
Assert-False (Test-JunkWatcherRunning -MaxAgeSeconds 60) 'Stale zero-exposure watcher remained healthy.'
Assert-LastState 'stale_zero_exposure_recycled'
Assert-True ($script:StoppedIds.Count -eq 1 -and $script:StoppedIds[0] -eq 4242) 'Exact stale watcher was not recycled.'
Assert-True ($script:LogMessages.Count -eq 1) 'Stale recycle did not write an audit warning.'

# A failed termination is treated as occupied/protected, so the top level cannot
# launch a duplicate watcher based on an unconfirmed recycle.
Reset-TestCase
$script:StopShouldFail = $true
Write-TestStatus (New-ValidStatus -UpdatedAt ([DateTimeOffset]::UtcNow.AddMinutes(-2).ToString('o')))
Assert-True (Test-JunkWatcherRunning -MaxAgeSeconds 60) 'Failed recycle allowed a replacement watcher.'
Assert-LastState 'stale_recycle_failed_preserved'
Assert-True $script:junkWatcherRequiresSupervisorRemoval 'Failed recycle left child restart authority enabled.'

# Activity or position exposure always protects a stale watcher from termination.
Reset-TestCase
$statusWithActiveOrder = New-ValidStatus -UpdatedAt ([DateTimeOffset]::UtcNow.AddMinutes(-2).ToString('o')) -ActiveOrders @(@{ order_id = 'sim-order' })
Write-TestStatus $statusWithActiveOrder
Assert-True (Test-JunkWatcherRunning -MaxAgeSeconds 60) 'Stale active-order watcher was not preserved.'
Assert-LastState 'stale_with_exposure_preserved'
Assert-True ($script:StoppedIds.Count -eq 0) 'Watcher with active orders was stopped.'
Assert-True $script:junkWatcherRequiresSupervisorRemoval 'Unsafe child supervisor was left authoritative over active orders.'

Reset-TestCase
$statusWithPosition = New-ValidStatus -UpdatedAt ([DateTimeOffset]::UtcNow.AddMinutes(-2).ToString('o')) -OpenPositionCount 1
Write-TestStatus $statusWithPosition
Assert-True (Test-JunkWatcherRunning -MaxAgeSeconds 60) 'Stale positioned watcher was not preserved.'
Assert-LastState 'stale_with_exposure_preserved'
Assert-True ($script:StoppedIds.Count -eq 0) 'Watcher with an open position was stopped.'
Assert-True $script:junkWatcherRequiresSupervisorRemoval 'Unsafe child supervisor was left authoritative over a position.'

# Missing exposure evidence and invalid simulation flags fail closed without a kill.
Reset-TestCase
$unknownExposure = New-ValidStatus -UpdatedAt ([DateTimeOffset]::UtcNow.AddMinutes(-2).ToString('o'))
$unknownExposure.Remove('risk')
Write-TestStatus $unknownExposure
Assert-True (Test-JunkWatcherRunning -MaxAgeSeconds 60) 'Unknown exposure watcher was not preserved.'
Assert-LastState 'stale_exposure_unknown_preserved'
Assert-True ($script:StoppedIds.Count -eq 0) 'Watcher with unknown exposure was stopped.'

Reset-TestCase
$wrongMode = New-ValidStatus
$wrongMode.mode = 'dry_run'
Write-TestStatus $wrongMode
Assert-True (Test-JunkWatcherRunning -MaxAgeSeconds 60) 'Invalid-mode repository watcher should remain occupied.'
Assert-LastState 'simulation_contract_invalid_preserved'
Assert-True ($script:StoppedIds.Count -eq 0) 'Invalid-mode watcher was stopped without exposure authority.'

Reset-TestCase
$stringFalse = New-ValidStatus
$stringFalse.real_trading_allowed = 'false'
Write-TestStatus $stringFalse
Assert-True (Test-JunkWatcherRunning -MaxAgeSeconds 60) 'Non-boolean real-trading flag was accepted as safe.'
Assert-LastState 'simulation_contract_invalid_preserved'
Assert-True ($script:StoppedIds.Count -eq 0) 'Contract-invalid watcher was stopped.'

# A PID that belongs to another script can never be killed by this recovery path.
Reset-TestCase
$script:MockProcesses = @([pscustomobject]@{
  Name = 'node.exe'
  ProcessId = 4242
  CommandLine = '"C:\node\node.exe" "C:\other\zero-dte-line.mjs" --watch --execute-simulate'
})
Write-TestStatus (New-ValidStatus -UpdatedAt ([DateTimeOffset]::UtcNow.AddMinutes(-2).ToString('o')))
Assert-False (Test-JunkWatcherRunning -MaxAgeSeconds 60) 'Foreign process was treated as repository watcher.'
Assert-True ($script:StoppedIds.Count -eq 0) 'Foreign process was stopped.'

# If a stale/exposed watcher must be preserved, Ensure-JunkSupervisor removes
# only the exact child restart supervisor so its independent watchdog cannot kill
# or duplicate that protected watcher.
Reset-TestCase
$junkSupervisorPath = Join-Path $rootPath 'run-junk-gex.ps1'
function Assert-SimulationOnlyConfiguration { }
function Test-JunkWatcherRunning {
  $script:junkWatcherRequiresSupervisorRemoval = $true
  return $true
}
function Get-RepositoryProcesses {
  param(
    [string]$CommandLineToken,
    [string[]]$ProcessNames,
    [string]$ExactPowerShellFilePath
  )
  return @([pscustomobject]@{ ProcessId = 9001 })
}
Assert-True (Ensure-JunkSupervisor) 'Protected watcher did not keep the top-level gate occupied.'
Assert-LastState 'protected_watcher_supervisor_removed'
Assert-True ($script:StoppedIds.Count -eq 1 -and $script:StoppedIds[0] -eq 9001) 'Exact child supervisor was not removed.'
`, { TEST_STACK_ROOT: temporaryRoot });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
