param(
  [int]$Port = 9222,
  [string]$BrowserPath = "",
  [string]$Profile = "$PSScriptRoot\profile",
  [string]$DiscordUrl = "https://discord.com/channels/1434960637561409689/1515786763417813094",
  [switch]$OpenDiscord
)

$ErrorActionPreference = "Stop"

function Resolve-BrowserPath {
  param([string]$ExplicitPath)

  $candidates = @()
  if ($ExplicitPath) {
    $candidates += $ExplicitPath
  }

  $roots = @(
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)},
    $env:LocalAppData
  ) | Where-Object { $_ }

  foreach ($root in $roots) {
    $candidates += Join-Path $root "Google\Chrome\Application\chrome.exe"
    $candidates += Join-Path $root "Microsoft\Edge\Application\msedge.exe"
  }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }

  throw "Chrome or Edge was not found. Pass -BrowserPath with the browser executable path."
}

$browser = Resolve-BrowserPath -ExplicitPath $BrowserPath
New-Item -ItemType Directory -Force -Path $Profile | Out-Null

$arguments = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$Profile",
  "--no-first-run",
  "--start-minimized"
)

if ($OpenDiscord) {
  if ($DiscordUrl -notmatch '^https://discord\.com/channels/\d+/\d+$') {
    throw "DiscordUrl must be a discord.com channel URL."
  }
  $arguments += $DiscordUrl
}

Start-Process -FilePath $browser -ArgumentList $arguments -WindowStyle Normal

Write-Host "Started browser: $browser"
Write-Host "CDP endpoint: http://127.0.0.1:$Port"
Write-Host "Next step: npm run capture"
