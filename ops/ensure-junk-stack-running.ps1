[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [ValidateRange(120, 1800)]
  [int]$StaleAfterSeconds = 300
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$stackScript = Join-Path $RepoRoot 'run-junk-stack.ps1'
$heartbeatPath = Join-Path $RepoRoot 'logs\junk-stack-heartbeat.json'
$keepaliveLogPath = Join-Path $RepoRoot 'logs\junk-stack-keepalive.log'
$powershellPath = Join-Path $PSHOME 'powershell.exe'

if (-not (Test-Path -LiteralPath $stackScript -PathType Leaf)) {
  throw "JUNKMAN stack supervisor not found: $stackScript"
}

function Write-KeepaliveLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  New-Item -ItemType Directory -Path (Split-Path -Parent $keepaliveLogPath) -Force | Out-Null
  Add-Content -LiteralPath $keepaliveLogPath -Encoding UTF8 -Value (
    '{0} {1}' -f (Get-Date -Format o), $Message
  )
}

function Get-StackProcesses {
  return @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $commandLine = [string]$_.CommandLine
        $_.Name -match '^(powershell|pwsh)\.exe$' -and
        $commandLine -match '(?i)-File\s+' -and
        $commandLine.IndexOf($stackScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
      }
  )
}

function Get-HeartbeatAgeSeconds {
  try {
    $heartbeat = Get-Content -LiteralPath $heartbeatPath -Raw -ErrorAction Stop | ConvertFrom-Json
    $updatedAt = [DateTimeOffset]::Parse(
      [string]$heartbeat.updated_at,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::AssumeUniversal
    ).ToUniversalTime()
    return [Math]::Max(0, ([DateTimeOffset]::UtcNow - $updatedAt).TotalSeconds)
  } catch {
    return [double]::PositiveInfinity
  }
}

$processes = @(Get-StackProcesses)
$heartbeatAge = Get-HeartbeatAgeSeconds
if ($processes.Count -eq 1 -and $heartbeatAge -le $StaleAfterSeconds) {
  exit 0
}

if ($processes.Count -gt 0) {
  $reason = if ([double]::IsPositiveInfinity($heartbeatAge)) {
    'missing_or_invalid_heartbeat'
  } else {
    'stale_heartbeat'
  }
  Write-KeepaliveLog "replacing_count=$($processes.Count); reason=$reason"
  foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

$started = Start-Process `
  -FilePath $powershellPath `
  -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    ('"{0}"' -f $stackScript)
  ) `
  -WorkingDirectory $RepoRoot `
  -WindowStyle Hidden `
  -PassThru
Write-KeepaliveLog "started_pid=$($started.Id); simulation_only=true"
