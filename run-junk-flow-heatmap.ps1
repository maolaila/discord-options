$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$createdNew = $false
$supervisorMutex = [System.Threading.Mutex]::new(
  $true,
  'Local\DiscordOptionsJunkFlowHeatmapSupervisor',
  [ref]$createdNew
)
if (-not $createdNew) {
  $supervisorMutex.Dispose()
  Write-Output 'The JUNKMAN-FLOW-HEATMAP supervisor is already running in this Windows session.'
  exit 0
}

try {
  $nightwatchKey = [Environment]::GetEnvironmentVariable('YEHANGSHE_API_KEY', 'User')
  if ([string]::IsNullOrWhiteSpace($nightwatchKey)) {
    throw 'YEHANGSHE_API_KEY is not configured in the Windows user environment.'
  }
  $env:YEHANGSHE_API_KEY = $nightwatchKey
  $nightwatchKey = $null

  $openDKey = [Environment]::GetEnvironmentVariable('MOOMOO_OPEND_WS_KEY', 'User')
  if (-not [string]::IsNullOrWhiteSpace($openDKey)) {
    $env:MOOMOO_OPEND_WS_KEY = $openDKey
  }
  $openDKey = $null

  $nodeCommand = Get-Command node -ErrorAction Stop
  $nodeVersionText = (& $nodeCommand.Source --version).Trim()
  if ($nodeVersionText -notmatch '^v?(\d+)\.(\d+)\.(\d+)$') {
    throw "JUNKMAN-FLOW-HEATMAP could not parse the Node.js version: $nodeVersionText"
  }
  $nodeVersion = [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
  if ($nodeVersion -lt [version]'24.15.0') {
    throw 'JUNKMAN-FLOW-HEATMAP requires Node.js 24.15 or newer.'
  }

  $logDirectory = Join-Path $PSScriptRoot 'logs'
  $supervisorLog = Join-Path $logDirectory 'junk-flow-heatmap-options-supervisor.log'
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $attempt = 0
  do {
    $attempt += 1
    $stdoutPath = Join-Path $logDirectory "junk-flow-heatmap-options-runtime-$PID-$attempt.stdout.log"
    $stderrPath = Join-Path $logDirectory "junk-flow-heatmap-options-runtime-$PID-$attempt.stderr.log"
    $watcher = Start-Process `
      -FilePath $nodeCommand.Source `
      -ArgumentList @(
        (Join-Path $PSScriptRoot 'apps\junk-flow-heatmap-options\junk-flow-heatmap-line.mjs'),
        '--watch',
        '--execute-simulate'
      ) `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -WindowStyle Hidden `
      -PassThru
    $watchdogRecycled = $false
    $watcherStartedAt = [DateTimeOffset]::UtcNow
    while (-not $watcher.HasExited) {
      Start-Sleep -Seconds 15
      $watcher.Refresh()
      if ($watcher.HasExited -or [DateTimeOffset]::UtcNow -lt $watcherStartedAt.AddMinutes(2)) { continue }
      $statusPath = Join-Path $logDirectory 'junk-flow-heatmap-options-status.json'
      $statePath = Join-Path $logDirectory 'junk-flow-heatmap-options-runtime-state.json'
      try {
        $status = Get-Content -LiteralPath $statusPath -Raw -ErrorAction Stop | ConvertFrom-Json
        $state = Get-Content -LiteralPath $statePath -Raw -ErrorAction Stop | ConvertFrom-Json
        $updatedAt = [DateTimeOffset]::Parse([string]$status.updated_at)
        $ageSeconds = ([DateTimeOffset]::UtcNow - $updatedAt.ToUniversalTime()).TotalSeconds
        $contractValid = (
          [int]$status.process_id -eq $watcher.Id -and
          [string]$status.mode -ceq 'execute_simulate' -and
          $status.real_trading_allowed -is [bool] -and
          -not [bool]$status.real_trading_allowed
        )
        $activeRows = @(
          @($state.orders.PSObject.Properties).Value |
            Where-Object { @('closed', 'entry_unfilled_terminal') -notcontains [string]$_.status }
        )
        if ($contractValid -and $ageSeconds -gt 300 -and $activeRows.Count -eq 0) {
          Stop-Process -Id $watcher.Id -Force -ErrorAction Stop
          $watcher.WaitForExit()
          $watchdogRecycled = $true
          Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) stale watcher recycled with zero locally-owned exposure; pid=$($watcher.Id)"
          break
        }
      } catch {
        # Missing, corrupt, mismatched, or exposure-bearing state is preserved.
      }
    }
    if (-not $watcher.HasExited) { $watcher.WaitForExit() }
    $exitCode = if ($watchdogRecycled) { 124 } else { $watcher.ExitCode }
    if ($exitCode -eq 0) { break }
    Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) watcher exited code=$exitCode; restarting in 15 seconds"
    Start-Sleep -Seconds 15
  } while ($true)
} finally {
  try { $supervisorMutex.ReleaseMutex() } catch { }
  $supervisorMutex.Dispose()
}
