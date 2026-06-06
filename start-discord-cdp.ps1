param(
  [int]$Port = 9222,
  [string]$BrowserPath = "",
  [string]$Profile = "$PSScriptRoot\profile",
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
  "--no-first-run"
)

if ($OpenDiscord) {
  $arguments += "https://discord.com/app"
}

Start-Process -FilePath $browser -ArgumentList $arguments -WindowStyle Normal

Write-Host "Started browser: $browser"
Write-Host "CDP endpoint: http://127.0.0.1:$Port"
Write-Host "Next step: npm run capture"
