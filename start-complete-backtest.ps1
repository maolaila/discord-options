param(
  [string]$EnvFile = "$PSScriptRoot\.env",
  [int]$QuotaSleepMinutes = 60
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$AnalysisDir = Join-Path $Root "analysis"
$LogsDir = Join-Path $Root "logs"
$PidFile = Join-Path $AnalysisDir "strict-pa-moomoo-backtest.pid"
$StatusFile = Join-Path $AnalysisDir "strict-pa-moomoo-backtest-status.json"
$OutLog = Join-Path $LogsDir "strict-pa-moomoo-backtest.out.log"
$ErrLog = Join-Path $LogsDir "strict-pa-moomoo-backtest.err.log"

New-Item -ItemType Directory -Force -Path $AnalysisDir, $LogsDir | Out-Null

if (Test-Path $PidFile) {
  $ExistingPid = [int](Get-Content $PidFile -Raw)
  $ExistingProcess = Get-Process -Id $ExistingPid -ErrorAction SilentlyContinue
  if ($ExistingProcess) {
    Write-Host "Complete backtest is already running. PID=$ExistingPid"
    if (Test-Path $StatusFile) {
      Get-Content $StatusFile -Raw
    }
    exit 0
  }
}

$Node = (Get-Command node).Source
$Args = @(
  ".\backtest-strict-pa-moomoo.mjs",
  "--env", $EnvFile,
  "--resume",
  "--wait-for-quota",
  "--quota-sleep-minutes", [string]$QuotaSleepMinutes
)

$Process = Start-Process `
  -FilePath $Node `
  -ArgumentList $Args `
  -WorkingDirectory $Root `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -WindowStyle Hidden `
  -PassThru

Set-Content -Path $PidFile -Value $Process.Id -Encoding ascii

Write-Host "Started complete backtest. PID=$($Process.Id)"
Write-Host "Status: $StatusFile"
Write-Host "Output log: $OutLog"
Write-Host "Error log: $ErrLog"
