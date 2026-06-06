param(
  [int]$Port = 18766,
  [string]$HostName = "127.0.0.1"
)

$ErrorActionPreference = "Stop"

$url = "http://$HostName`:$Port"
$node = (Get-Command node -ErrorAction Stop).Source

$listening = $false
try {
  $test = Test-NetConnection -ComputerName $HostName -Port $Port -WarningAction SilentlyContinue
  $listening = [bool]$test.TcpTestSucceeded
} catch {
  $listening = $false
}

if (-not $listening) {
  $out = Join-Path $PSScriptRoot "logs\control-console.out.log"
  $err = Join-Path $PSScriptRoot "logs\control-console.err.log"
  New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot "logs") | Out-Null
  Start-Process -FilePath $node `
    -ArgumentList @("control-console.mjs") `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err
  Start-Sleep -Seconds 1
}

Start-Process $url
Write-Host "Control console: $url"
