$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$AnalysisDir = Join-Path $Root "analysis"
$LogsDir = Join-Path $Root "logs"
$PidFile = Join-Path $AnalysisDir "strict-pa-moomoo-backtest.pid"
$StatusFile = Join-Path $AnalysisDir "strict-pa-moomoo-backtest-status.json"
$ResultFile = Join-Path $AnalysisDir "strict-pa-moomoo-backtest-results.json"
$OutLog = Join-Path $LogsDir "strict-pa-moomoo-backtest.out.log"
$ErrLog = Join-Path $LogsDir "strict-pa-moomoo-backtest.err.log"

if (Test-Path $PidFile) {
  $PidValue = [int](Get-Content $PidFile -Raw)
  $Process = Get-Process -Id $PidValue -ErrorAction SilentlyContinue
  if ($Process) {
    Write-Host "Process: running PID=$PidValue"
  } else {
    Write-Host "Process: not running, last PID=$PidValue"
  }
} else {
  Write-Host "Process: no PID file"
}

if (Test-Path $StatusFile) {
  Write-Host "`nStatus:"
  Get-Content $StatusFile -Raw
}

if (Test-Path $ResultFile) {
  Write-Host "`nCurrent result:"
  & node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(JSON.stringify(r.summary,null,2));" $ResultFile
}

if (Test-Path $OutLog) {
  Write-Host "`nOutput log tail:"
  Get-Content $OutLog -Tail 20
}

if (Test-Path $ErrLog) {
  $ErrTail = Get-Content $ErrLog -Tail 20
  if ($ErrTail) {
    Write-Host "`nError log tail:"
    $ErrTail
  }
}
