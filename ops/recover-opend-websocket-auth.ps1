[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [ValidateRange(30, 85)]
  [int]$MaxRuntimeSeconds = 75,
  [ValidateRange(5, 30)]
  [int]$ProbeTimeoutSeconds = 15
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$checkScript = Join-Path $RepoRoot 'apps\opend-check\moomoo-check.mjs'
$logDirectory = Join-Path $RepoRoot 'logs'
$stdoutPath = Join-Path $logDirectory '.opend-auth-recovery.stdout.log'
$stderrPath = Join-Path $logDirectory '.opend-auth-recovery.stderr.log'

function Get-Node20Path {
  foreach ($command in @(Get-Command node -All -ErrorAction SilentlyContinue)) {
    try {
      $version = & $command.Source --version 2>$null
      if ($version -match '^v(\d+)' -and [int]$Matches[1] -ge 20) {
        return [string]$command.Source
      }
    } catch { }
  }
  throw 'Node.js 20 or newer was not found.'
}

function Await-WindowsRuntimeOperation {
  param(
    [Parameter(Mandatory = $true)]$Operation,
    [Parameter(Mandatory = $true)][Type]$ResultType
  )

  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.IsGenericMethod -and
      $_.GetParameters().Count -eq 1
    } |
    Select-Object -First 1
  $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}

function Add-AmbiguousTextVariants {
  param([Parameter(Mandatory = $true)][string]$Text)

  $variants = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
  )
  $variants.Add($Text) | Out-Null
  $groups = @(
    @('0', 'O', 'o'),
    @('1', 'I', 'i', 'l')
  )

  for ($index = 0; $index -lt $Text.Length; $index += 1) {
    $current = [string]$Text[$index]
    $group = $groups | Where-Object { $_ -contains $current } | Select-Object -First 1
    if (-not $group) { continue }
    foreach ($existing in @($variants)) {
      foreach ($replacement in $group) {
        $chars = $existing.ToCharArray()
        $chars[$index] = [char]$replacement
        $variants.Add((-join $chars)) | Out-Null
        if ($variants.Count -ge 128) { return @($variants) }
      }
    }
  }
  return @($variants)
}

if (-not (Test-Path -LiteralPath $checkScript -PathType Leaf)) {
  throw "OpenD health check not found: $checkScript"
}

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$nodePath = Get-Node20Path
$openDProcessIds = [System.Collections.Generic.HashSet[uint32]]::new()
foreach ($process in @(Get-Process -Name 'moomoo_OpenD' -ErrorAction Stop)) {
  $openDProcessIds.Add([uint32]$process.Id) | Out-Null
}

$nativeCode = @'
using System;
using System.Runtime.InteropServices;
public static class OpenDRecoveryWindow {
    public delegate bool EnumWindowsCallback(IntPtr handle, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr handle, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
}
'@
Add-Type -TypeDefinition $nativeCode
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$windows = [System.Collections.Generic.List[object]]::new()
[OpenDRecoveryWindow]::EnumWindows({
  param($handle, $parameter)
  [uint32]$processId = 0
  [OpenDRecoveryWindow]::GetWindowThreadProcessId($handle, [ref]$processId) | Out-Null
  if ($openDProcessIds.Contains($processId) -and [OpenDRecoveryWindow]::IsWindowVisible($handle)) {
    $rect = [OpenDRecoveryWindow+Rect]::new()
    if (-not [OpenDRecoveryWindow]::GetWindowRect($handle, [ref]$rect)) { return $true }
    $area = [Math]::Max(0, $rect.Right - $rect.Left) * [Math]::Max(0, $rect.Bottom - $rect.Top)
    $windows.Add([pscustomobject]@{
      handle = $handle
      area = $area
      original_left = $rect.Left
      original_top = $rect.Top
      original_width = [Math]::Max(0, $rect.Right - $rect.Left)
      original_height = [Math]::Max(0, $rect.Bottom - $rect.Top)
    })
  }
  return $true
}, [IntPtr]::Zero) | Out-Null

$window = $windows | Sort-Object area -Descending | Select-Object -First 1
if (-not $window) { throw 'No visible moomoo OpenD window was found.' }

$noSize = 0x0001
$showWindow = 0x0040
$topMost = [IntPtr](-1)
$notTopMost = [IntPtr](-2)
$originalDirectKey = $env:MOOMOO_OPEND_WS_KEY
$authenticated = $false
$attemptCount = 0
$recoveryDeadline = [DateTimeOffset]::UtcNow.AddSeconds($MaxRuntimeSeconds)
$imageStream = $null
$randomAccessStream = $null
$softwareBitmap = $null

try {
  [OpenDRecoveryWindow]::ShowWindow($window.handle, 9) | Out-Null
  # Move the lower OpenD status panel into view without changing its size.
  [OpenDRecoveryWindow]::SetWindowPos(
    $window.handle,
    $topMost,
    10,
    -420,
    0,
    0,
    ($noSize -bor $showWindow)
  ) | Out-Null
  Start-Sleep -Seconds 2

  # OpenD is fixed-size on this workstation. After moving it to x=10/y=-420,
  # the key value occupies this narrow strip. Capturing only that strip keeps
  # account details and the rest of the desktop out of the temporary image.
  $captureLeft = 900
  $captureTop = 60
  $captureWidth = 420
  $captureHeight = 90
  $sourceBitmap = [Drawing.Bitmap]::new($captureWidth, $captureHeight)
  $graphics = [Drawing.Graphics]::FromImage($sourceBitmap)
  try {
    $graphics.CopyFromScreen($captureLeft, $captureTop, 0, 0, $sourceBitmap.Size)
  } finally {
    $graphics.Dispose()
  }
  $bitmap = [Drawing.Bitmap]::new($captureWidth * 4, $captureHeight * 4)
  $scaledGraphics = [Drawing.Graphics]::FromImage($bitmap)
  $imageStream = [IO.MemoryStream]::new()
  try {
    $scaledGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $scaledGraphics.DrawImage($sourceBitmap, 0, 0, $bitmap.Width, $bitmap.Height)
    # Keep the credential-bearing crop in memory only. A previous implementation
    # used a temporary PNG path, which could survive an abnormal process exit.
    $bitmap.Save($imageStream, [Drawing.Imaging.ImageFormat]::Png)
    $imageStream.Position = 0
  } finally {
    $scaledGraphics.Dispose()
    $bitmap.Dispose()
    $sourceBitmap.Dispose()
  }

  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
  $randomAccessStream = [IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($imageStream)
  $decoder = Await-WindowsRuntimeOperation `
    -Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($randomAccessStream)) `
    -ResultType ([Windows.Graphics.Imaging.BitmapDecoder])
  $softwareBitmap = Await-WindowsRuntimeOperation `
    -Operation ($decoder.GetSoftwareBitmapAsync()) `
    -ResultType ([Windows.Graphics.Imaging.SoftwareBitmap])
  $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  $ocrResult = Await-WindowsRuntimeOperation `
    -Operation ($ocrEngine.RecognizeAsync($softwareBitmap)) `
    -ResultType ([Windows.Media.Ocr.OcrResult])

  $rawCandidates = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
  )
  @(
    [regex]::Matches(
      [string]$ocrResult.Text,
      '(?<![A-Za-z0-9])[A-Za-z0-9]{16}(?![A-Za-z0-9])'
    ) | ForEach-Object { $_.Value }
  ) | ForEach-Object { $rawCandidates.Add($_) | Out-Null }
  $joinedAscii = ([regex]::Replace([string]$ocrResult.Text, '[^A-Za-z0-9]', ''))
  if ($joinedAscii.Length -ge 16) {
    for ($start = 0; $start -le $joinedAscii.Length - 16; $start += 1) {
      $rawCandidates.Add($joinedAscii.Substring($start, 16)) | Out-Null
    }
  }
  $candidateSet = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
  )
  foreach ($rawCandidate in @($rawCandidates)) {
    foreach ($candidate in @(Add-AmbiguousTextVariants -Text $rawCandidate)) {
      $candidateSet.Add($candidate) | Out-Null
      if ($candidateSet.Count -ge 128) { break }
    }
    if ($candidateSet.Count -ge 128) { break }
  }

  foreach ($candidate in @($candidateSet)) {
    $remainingSeconds = ($recoveryDeadline - [DateTimeOffset]::UtcNow).TotalSeconds
    if ($remainingSeconds -le 1) { break }
    $attemptCount += 1
    $env:MOOMOO_OPEND_WS_KEY = $candidate
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    $probe = Start-Process `
      -FilePath $nodePath `
      -ArgumentList ('"{0}"' -f $checkScript) `
      -WorkingDirectory $RepoRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -PassThru
    $attemptDeadline = [DateTimeOffset]::UtcNow.AddSeconds(
      [Math]::Min($ProbeTimeoutSeconds, [Math]::Max(1, $remainingSeconds - 1))
    )
    while (-not $probe.HasExited -and [DateTimeOffset]::UtcNow -lt $attemptDeadline) {
      Start-Sleep -Milliseconds 200
      $probe.Refresh()
    }
    if (-not $probe.HasExited) {
      & "$env:SystemRoot\System32\taskkill.exe" /PID $probe.Id /T /F 1>$null 2>$null
      try { $probe.WaitForExit(5000) | Out-Null } catch { }
      $probe.Dispose()
      # A stuck probe indicates a transport problem, not another OCR variant.
      # Exit through finally so the OpenD window is restored before the parent
      # watchdog's harder 90-second process-tree deadline.
      break
    }
    $probe.WaitForExit()
    $probeExitCode = $probe.ExitCode
    $probe.Dispose()
    if ($probeExitCode -eq 0) {
      [Environment]::SetEnvironmentVariable('MOOMOO_OPEND_WS_KEY', $candidate, 'User')
      $authenticated = $true
      break
    }
  }
} finally {
  [OpenDRecoveryWindow]::SetWindowPos(
    $window.handle,
    $notTopMost,
    $window.original_left,
    $window.original_top,
    $window.original_width,
    $window.original_height,
    $showWindow
  ) | Out-Null
  if ($null -eq $originalDirectKey) {
    Remove-Item Env:MOOMOO_OPEND_WS_KEY -ErrorAction SilentlyContinue
  } else {
    $env:MOOMOO_OPEND_WS_KEY = $originalDirectKey
  }
  if ($null -ne $softwareBitmap) { $softwareBitmap.Dispose() }
  if ($null -ne $randomAccessStream) { $randomAccessStream.Dispose() }
  if ($null -ne $imageStream) { $imageStream.Dispose() }
  Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
}

[pscustomobject]@{
  authentication_recovered = $authenticated
  attempted_candidates = $attemptCount
  persisted_to_user_environment = $authenticated
} | ConvertTo-Json -Compress

if (-not $authenticated) { exit 2 }
