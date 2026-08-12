$ErrorActionPreference = 'Stop'

Set-Location -LiteralPath $PSScriptRoot

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
    while (-not $watcher.HasExited) {
      Start-Sleep -Seconds 15
      $watcher.Refresh()
      if ($watcher.HasExited) { break }
      if ((Get-Date) -lt $watcherStartedAt.AddMinutes(2)) { continue }
      $statusItem = Get-Item -LiteralPath $statusPath -ErrorAction SilentlyContinue
      if ($statusItem -and $statusItem.LastWriteTime -lt (Get-Date).AddMinutes(-5)) {
        $watchdogTriggered = $true
        Add-Content -LiteralPath $supervisorPath -Value "$(Get-Date -Format o) watcher heartbeat stale; stopping pid=$($watcher.Id)"
        Stop-Process -Id $watcher.Id -Force
        $watcher.WaitForExit()
        break
      }
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
