$ErrorActionPreference = "Stop"

$statusFile = Join-Path $PSScriptRoot "logs\capture-status.json"
if (-not (Test-Path -LiteralPath $statusFile)) {
  throw "Status file does not exist yet: $statusFile"
}

$status = Get-Content -LiteralPath $statusFile -Encoding UTF8 -Raw | ConvertFrom-Json
$status | Format-List

$files = @(
  "logs\messages.ndjson",
  "logs\zero-dte-options-flow-events.ndjson",
  "logs\raw-events.ndjson",
  "logs\capture-status.json"
)

Write-Host ""
Write-Host "Files:"
foreach ($relative in $files) {
  $file = Join-Path $PSScriptRoot $relative
  if (Test-Path -LiteralPath $file) {
    $item = Get-Item -LiteralPath $file
    Write-Host "$relative`tlength=$($item.Length)`tlast_write=$($item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))"
  } else {
    Write-Host "$relative`tmissing"
  }
}
