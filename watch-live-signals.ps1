param(
  [int]$Tail = 20
)

$ErrorActionPreference = "Stop"

chcp.com 65001 | Out-Null
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$global:OutputEncoding = $utf8NoBom

$file = Join-Path $PSScriptRoot "logs\live-signals.ndjson"
if (-not (Test-Path -LiteralPath $file)) {
  throw "Live signal log does not exist yet: $file"
}

function Convert-LineToRecord {
  param([string]$Line)

  $clean = $Line.Trim()
  if (-not $clean) { return $null }
  if ($clean[0] -eq [char]0xfeff) { $clean = $clean.Substring(1) }
  if (-not $clean) { return $null }
  return $clean | ConvertFrom-Json
}

function Get-FieldValue {
  param($Embed, [string[]]$Names)

  if (-not $Embed -or -not $Embed.fields) { return "" }
  foreach ($name in $Names) {
    $field = $Embed.fields | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if ($field) { return $field.value }
  }
  return ""
}

Get-Content -LiteralPath $file -Encoding UTF8 -Tail $Tail -Wait | ForEach-Object {
  $record = Convert-LineToRecord -Line $_
  if (-not $record) { return }

  $embed = $record.embeds[0]
  $execution = Get-FieldValue -Embed $embed -Names @("执行观点", "执行计划", "decision", "结论")
  $risk = Get-FieldValue -Embed $embed -Names @("失效条件", "confidence_score", "风险提示")

  Write-Host "[$($record.captured_at)] lag=$($record.capture_lag_ms)ms channel=$($record.channel_id) id=$($record.id)"
  Write-Host "title: $($embed.title)"
  if ($execution) { Write-Host "signal: $execution" }
  if ($risk) { Write-Host "risk: $risk" }
  Write-Host ""
}
