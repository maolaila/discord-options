param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [int]$Tail = 80
)

$ErrorActionPreference = "Stop"

chcp.com 65001 | Out-Null
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$global:OutputEncoding = $utf8NoBom

$dir = Join-Path $PSScriptRoot "signal-docs"
$file = Join-Path $dir "$Date.md"

if (-not (Test-Path -LiteralPath $dir)) {
  New-Item -ItemType Directory -Path $dir | Out-Null
}

if (-not (Test-Path -LiteralPath $file)) {
  New-Item -ItemType File -Path $file | Out-Null
} else {
  $existingText = Get-Content -LiteralPath $file -Encoding UTF8 -Raw
  if (-not ($existingText -match '(?m)^##\s')) {
    [System.IO.File]::WriteAllBytes($file, [byte[]]@())
  }
}

Write-Host "Watching signal document: $file"
Write-Host "If this stays empty, no option signal has been logged for this date yet."
Get-Content -LiteralPath $file -Encoding UTF8 -Tail $Tail -Wait
