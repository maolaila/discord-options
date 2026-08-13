import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supervisorScriptPath = path.join(repositoryRoot, 'run-junk-gex.ps1');
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
      env: {
        ...process.env,
        JUNK_GEX_SUPERVISOR_PATH: supervisorScriptPath,
        ...extraEnv,
      },
      input: source,
      timeout: 30_000,
    },
  );
}

test('run-junk-gex.ps1 passes the PowerShell parser', () => {
  const result = runPowerShell(String.raw`
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  $env:JUNK_GEX_SUPERVISOR_PATH,
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

test('standalone supervisor retains its singleton and 15-second restart contract', () => {
  const source = readFileSync(supervisorScriptPath, 'utf8');
  assert.match(source, /Local\\DiscordOptionsJunkGexSupervisor/);
  assert.match(source, /'--watch'[\s\S]*'--execute-simulate'/);
  assert.match(source, /watcher exited code=.*restarting in 15 seconds/);
  assert.match(source, /Start-Sleep -Seconds 15/);
});

test('standalone watchdog recycles only stale, current-PID, zero-exposure simulate watcher', () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'junk-gex-watchdog-'));
  try {
    const result = runPowerShell(String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $env:JUNK_GEX_SUPERVISOR_PATH,
  [ref]$tokens,
  [ref]$errors
)
if ($errors.Count -gt 0) { throw 'The supervisor source did not parse.' }

$wantedFunctions = @(
  'Get-JunkGexWatchdogStatusAssessment',
  'Read-JunkGexWatchdogStatusAssessment',
  'Test-ExactJunkGexWatcherProcess',
  'Invoke-JunkGexWatchdogRecycle'
)
$functionAsts = @($ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $wantedFunctions -contains $node.Name
}, $true))
if ($functionAsts.Count -ne $wantedFunctions.Count) {
  throw "Expected $($wantedFunctions.Count) watchdog functions, found $($functionAsts.Count)."
}
foreach ($name in $wantedFunctions) {
  $definition = $functionAsts | Where-Object Name -eq $name | Select-Object -First 1
  Invoke-Expression $definition.Extent.Text
}

$rootPath = $env:TEST_JUNK_ROOT
$statusPath = Join-Path $rootPath 'logs\zero-dte-options-status.json'
$watcherScript = Join-Path $rootPath 'apps\zero-dte-options\zero-dte-line.mjs'
New-Item -ItemType Directory -Path (Split-Path -Parent $statusPath) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $watcherScript) -Force | Out-Null
$script:MockProcesses = @()
$script:StoppedIds = @()

function Get-CimInstance {
  [CmdletBinding()]
  param(
    [Parameter(Position = 0)][string]$ClassName,
    [string]$Filter
  )
  return @($script:MockProcesses)
}

function Stop-Process {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][int]$Id,
    [switch]$Force
  )
  $script:StoppedIds += $Id
  $script:MockProcesses = @($script:MockProcesses | Where-Object { [int]$_.ProcessId -ne $Id })
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) {
    throw "$Message (actual=$Actual expected=$Expected)"
  }
}

$expectedPid = 4242
$now = [DateTimeOffset]::UtcNow
$startedAt = $now.AddMinutes(-20)
$staleAt = $now.AddMinutes(-10).ToString('o')
$freshAt = $now.ToString('o')
$script:MockProcesses = @([pscustomobject]@{
  Name = 'node.exe'
  ProcessId = $expectedPid
  CommandLine = '"C:\node\node.exe" "' + $watcherScript + '" --watch --execute-simulate'
})

function Write-Status([hashtable]$Values) {
  $Values | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding UTF8
}

Write-Status @{
  updated_at = $staleAt
  process_id = $expectedPid
  mode = 'execute_simulate'
  real_trading_allowed = $false
  active_orders = @()
  risk = @{ open_position_count = 0 }
}
$assessmentArguments = @{
  Status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
  ExpectedProcessId = $expectedPid
  MaxAgeSeconds = 300
  Now = $now
  MinimumHeartbeatAt = $startedAt
}
$assessment = Get-JunkGexWatchdogStatusAssessment @assessmentArguments
Assert-Equal $assessment.State 'stale_zero_exposure_confirmed' 'zero exposure stale status should be recyclable'
Assert-Equal $assessment.SafeToRecycle $true 'zero exposure stale status should pass the recycle contract'

$recycleArguments = @{
  StatusPath = $statusPath
  ExpectedProcessId = $expectedPid
  RootPath = $rootPath
  MaxAgeSeconds = 300
  MinimumHeartbeatAt = $startedAt
}
$result = Invoke-JunkGexWatchdogRecycle @recycleArguments
Assert-Equal $result.Action 'recycle' 'safe stale watcher should be recycled'
Assert-Equal @($script:StoppedIds).Count 1 'safe stale watcher should be stopped exactly once'
Assert-Equal $script:StoppedIds[0] $expectedPid 'watchdog should stop only the expected watcher PID'

# Recreate the process; every incomplete, unreadable, mismatched, unsafe, or
# exposed status below must preserve it.
$script:MockProcesses = @([pscustomobject]@{
  Name = 'node.exe'
  ProcessId = $expectedPid
  CommandLine = '"C:\node\node.exe" "' + $watcherScript + '" --watch --execute-simulate'
})
$script:StoppedIds = @()
Remove-Item -LiteralPath $statusPath -ErrorAction SilentlyContinue
$result = Invoke-JunkGexWatchdogRecycle -StatusPath $statusPath -ExpectedProcessId $expectedPid -RootPath $rootPath -MinimumHeartbeatAt $startedAt
Assert-Equal $result.State 'status_missing_preserved' 'missing status must be preserved'

Set-Content -LiteralPath $statusPath -Value '{not-json' -Encoding UTF8
$result = Invoke-JunkGexWatchdogRecycle -StatusPath $statusPath -ExpectedProcessId $expectedPid -RootPath $rootPath -MinimumHeartbeatAt $startedAt
Assert-Equal $result.State 'status_unreadable_preserved' 'corrupt status must be preserved'

Write-Status @{
  updated_at = $staleAt
  process_id = 9999
  mode = 'execute_simulate'
  real_trading_allowed = $false
  active_orders = @()
  risk = @{ open_position_count = 0 }
}
$result = Invoke-JunkGexWatchdogRecycle -StatusPath $statusPath -ExpectedProcessId $expectedPid -RootPath $rootPath -MinimumHeartbeatAt $startedAt
Assert-Equal $result.State 'status_pid_mismatch_preserved' 'PID mismatch must be preserved'

Write-Status @{
  updated_at = $staleAt
  process_id = $expectedPid
  mode = 'dry_run'
  real_trading_allowed = $false
  active_orders = @()
  risk = @{ open_position_count = 0 }
}
$result = Invoke-JunkGexWatchdogRecycle -StatusPath $statusPath -ExpectedProcessId $expectedPid -RootPath $rootPath -MinimumHeartbeatAt $startedAt
Assert-Equal $result.State 'simulation_contract_invalid_preserved' 'invalid mode must be preserved'

Write-Status @{
  updated_at = $staleAt
  process_id = $expectedPid
  mode = 'execute_simulate'
  real_trading_allowed = $false
  risk = @{ open_position_count = 0 }
}
$result = Invoke-JunkGexWatchdogRecycle -StatusPath $statusPath -ExpectedProcessId $expectedPid -RootPath $rootPath -MinimumHeartbeatAt $startedAt
Assert-Equal $result.State 'stale_exposure_unknown_preserved' 'unknown active orders must be preserved'

Write-Status @{
  updated_at = $staleAt
  process_id = $expectedPid
  mode = 'execute_simulate'
  real_trading_allowed = $false
  active_orders = @(@{ order_id = 'redacted' })
  risk = @{ open_position_count = 0 }
}
$result = Invoke-JunkGexWatchdogRecycle -StatusPath $statusPath -ExpectedProcessId $expectedPid -RootPath $rootPath -MinimumHeartbeatAt $startedAt
Assert-Equal $result.State 'stale_with_exposure_preserved' 'active orders must preserve the watcher'

Write-Status @{
  updated_at = $staleAt
  process_id = $expectedPid
  mode = 'execute_simulate'
  real_trading_allowed = $false
  active_orders = @()
  risk = @{ open_position_count = 1 }
}
$result = Invoke-JunkGexWatchdogRecycle -StatusPath $statusPath -ExpectedProcessId $expectedPid -RootPath $rootPath -MinimumHeartbeatAt $startedAt
Assert-Equal $result.State 'stale_with_exposure_preserved' 'open positions must preserve the watcher'

Write-Status @{
  updated_at = $freshAt
  process_id = $expectedPid
  mode = 'execute_simulate'
  real_trading_allowed = $false
  active_orders = @()
  risk = @{ open_position_count = 0 }
}
$freshAssessmentArguments = @{
  Status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
  ExpectedProcessId = $expectedPid
  Now = $now
  MinimumHeartbeatAt = $startedAt
}
$freshAssessment = Get-JunkGexWatchdogStatusAssessment @freshAssessmentArguments
Assert-Equal $freshAssessment.State 'healthy' 'fresh heartbeat should stay healthy'

# A status timestamp inherited from a prior watcher may be old, but it is not
# evidence that this newly-started PID hung. Preserve until this PID writes.
Write-Status @{
  updated_at = $now.AddHours(-1).ToString('o')
  process_id = $expectedPid
  mode = 'execute_simulate'
  real_trading_allowed = $false
  active_orders = @()
  risk = @{ open_position_count = 0 }
}
$newStart = $now.AddMinutes(-1)
$oldAssessmentArguments = @{
  Status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
  ExpectedProcessId = $expectedPid
  Now = $now
  MinimumHeartbeatAt = $newStart
}
$assessment = Get-JunkGexWatchdogStatusAssessment @oldAssessmentArguments
Assert-Equal $assessment.State 'heartbeat_invalid_preserved' 'pre-start status must not kill a new watcher'

Assert-Equal @($script:StoppedIds).Count 0 'unsafe status cases must not stop any process'
`, { TEST_JUNK_ROOT: temporaryRoot });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
