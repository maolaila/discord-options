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
$envPath = Join-Path $RepoRoot '.env'

function Resolve-WebSocketKeyFilePath {
  $configuredPath = $null
  if (Test-Path -LiteralPath $envPath -PathType Leaf) {
    foreach ($line in Get-Content -LiteralPath $envPath -ErrorAction Stop) {
      if ($line -match '^\s*MOOMOO_OPEND_WS_KEY_FILE\s*=\s*(.*?)\s*$') {
        $configuredPath = ([string]$Matches[1]).Trim().Trim('"').Trim("'")
        break
      }
    }
  }
  if ([string]::IsNullOrWhiteSpace($configuredPath)) {
    $configuredPath = 'secrets\moomoo_opend_ws_key.txt'
  }

  $candidatePath = if ([IO.Path]::IsPathRooted($configuredPath)) {
    $configuredPath
  } else {
    Join-Path $RepoRoot $configuredPath
  }
  $resolvedPath = [IO.Path]::GetFullPath($candidatePath)
  $allowedRoot = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'secrets')) +
    [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedPath.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'MOOMOO_OPEND_WS_KEY_FILE must resolve inside the repository secrets directory.'
  }
  return $resolvedPath
}

function Save-AuthenticatedWebSocketKey {
  param([Parameter(Mandatory = $true)][string]$Value)

  $keyFilePath = Resolve-WebSocketKeyFilePath
  [IO.Directory]::CreateDirectory((Split-Path -Parent $keyFilePath)) | Out-Null
  [IO.File]::WriteAllText(
    $keyFilePath,
    $Value + [Environment]::NewLine,
    [Text.UTF8Encoding]::new($false)
  )
}

function Get-Node24Path {
  foreach ($command in @(Get-Command node -All -ErrorAction SilentlyContinue)) {
    try {
      $version = & $command.Source --version 2>$null
      if ($version -match '^v?(\d+)\.(\d+)\.(\d+)$' -and
          [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3]) -ge [version]'24.15.0') {
        return [string]$command.Source
      }
    } catch { }
  }
  throw 'Node.js 24.15 or newer was not found.'
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
    @('1', 'I', 'i', 'l'),
    @('V', 'U', 'W')
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
$nodePath = Get-Node24Path
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
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
Add-Type -TypeDefinition $nativeCode
[OpenDRecoveryWindow]::SetProcessDPIAware() | Out-Null
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
$ocrTextLength = 0
$joinedAsciiLength = 0
$ocrShape = ''
$recoveryDeadline = [DateTimeOffset]::UtcNow.AddSeconds($MaxRuntimeSeconds)
$imageStream = $null
$randomAccessStream = $null
$softwareBitmap = $null

try {
  [OpenDRecoveryWindow]::ShowWindow($window.handle, 9) | Out-Null
  # Keep the credential row on-screen without resizing the DPI-scaled window.
  # The previous fixed screen coordinates only matched one workstation scale
  # and could silently crop an unrelated blank strip after an OpenD restart.
  $captureRelativeTop = [int][Math]::Round($window.original_height * 0.68)
  $captureHeight = [int][Math]::Max(90, [Math]::Round($window.original_height * 0.11))
  $targetLeft = $window.original_left
  $targetTop = $window.original_top
  [OpenDRecoveryWindow]::SetWindowPos(
    $window.handle,
    $topMost,
    $targetLeft,
    $targetTop,
    0,
    0,
    ($noSize -bor $showWindow)
  ) | Out-Null
  Start-Sleep -Seconds 2

  # Capture only the WebSocket key value. Excluding labels and port numbers
  # prevents the sliding-window candidate generator from spending its bounded
  # runtime on unrelated 16-character combinations.
  $captureLeft = $targetLeft + [int][Math]::Round($window.original_width * 0.585)
  $captureTop = $targetTop + $captureRelativeTop
  $captureWidth = [int][Math]::Max(320, [Math]::Round($window.original_width * 0.25))
  $sourceBitmap = [Drawing.Bitmap]::new($captureWidth, $captureHeight)
  $graphics = [Drawing.Graphics]::FromImage($sourceBitmap)
  try {
    $graphics.CopyFromScreen($captureLeft, $captureTop, 0, 0, $sourceBitmap.Size)
  } finally {
    $graphics.Dispose()
  }
  # Keep the scaled crop below Windows OCR's maximum image dimension.
  $scaleFactor = [Math]::Max(1, [Math]::Min(3, [int][Math]::Floor(2400 / $captureWidth)))
  $bitmap = [Drawing.Bitmap]::new(
    $captureWidth * $scaleFactor,
    $captureHeight * $scaleFactor
  )
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
  $ocrTextLength = ([string]$ocrResult.Text).Length
  $ocrShape = -join @(([string]$ocrResult.Text).ToCharArray() | ForEach-Object {
    if ($_ -cmatch '[A-Z]') { 'U' }
    elseif ($_ -cmatch '[a-z]') { 'L' }
    elseif ($_ -match '[0-9]') { 'D' }
    elseif ([char]::IsWhiteSpace($_)) { 'S' }
    else { 'X' }
  })

  $rawCandidates = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
  )
  @(
    [regex]::Matches(
      [string]$ocrResult.Text,
      '(?<![A-Za-z0-9])[A-Za-z0-9]{16}(?![A-Za-z0-9])'
    ) | ForEach-Object { $_.Value }
  ) | ForEach-Object { $rawCandidates.Add($_) | Out-Null }
  $compactOcrText = [regex]::Replace([string]$ocrResult.Text, '\s', '')
  if ($compactOcrText.Length -eq 16 -and $compactOcrText -match '[^A-Za-z0-9]') {
    # OCR commonly renders a narrow key character as punctuation. Preserve its
    # position and try a small bounded replacement set instead of deleting it.
    foreach ($replacement in @('0', 'O', 'o', '1', 'I', 'i', 'l', 'j', 'J')) {
      $rawCandidates.Add(
        ([regex]::Replace($compactOcrText, '[^A-Za-z0-9]', $replacement))
      ) | Out-Null
    }
  }
  $joinedAscii = ([regex]::Replace([string]$ocrResult.Text, '[^A-Za-z0-9]', ''))
  $joinedAsciiLength = $joinedAscii.Length
  if ($joinedAscii.Length -ge 16) {
    for ($start = 0; $start -le $joinedAscii.Length - 16; $start += 1) {
      $rawCandidates.Add($joinedAscii.Substring($start, 16)) | Out-Null
    }
  }
  $candidateSet = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
  )
  $orderedCandidates = [System.Collections.Generic.List[string]]::new()
  if ($joinedAscii.Length -eq 15) {
    # A narrow character such as j/I/l/1 can disappear entirely during OCR.
    # OCR can also collapse adjacent duplicate characters. Try duplication first,
    # then a bounded positional insertion set before broader ambiguity variants.
    foreach ($insertedGlyph in @('V', 'U', 'W')) {
      for ($position = $joinedAscii.Length; $position -ge 0; $position -= 1) {
        $insertedCandidate = $joinedAscii.Insert($position, $insertedGlyph)
        foreach ($variant in @(
          $insertedCandidate,
          $insertedCandidate.Replace('U', 'V'),
          $insertedCandidate.Replace('W', 'V')
        )) {
          if ($candidateSet.Add($variant)) {
            $orderedCandidates.Add($variant)
          }
        }
      }
    }
    for ($position = $joinedAscii.Length - 1; $position -ge 0; $position -= 1) {
      $duplicatedCandidate = $joinedAscii.Insert(
        $position,
        [string]$joinedAscii[$position]
      )
      $duplicateVariants = [System.Collections.Generic.List[string]]::new()
      $duplicateVariants.Add($duplicatedCandidate)
      foreach ($glyphIndex in 0..($duplicatedCandidate.Length - 1)) {
        $glyph = [string]$duplicatedCandidate[$glyphIndex]
        $glyphGroup = @(
          @('0', 'O', 'o'),
          @('1', 'I', 'i', 'l'),
          @('V', 'U', 'W')
        ) | Where-Object { $_ -contains $glyph } | Select-Object -First 1
        if (-not $glyphGroup) { continue }
        foreach ($replacement in $glyphGroup) {
          if ($replacement -ceq $glyph) { continue }
          $chars = $duplicatedCandidate.ToCharArray()
          $chars[$glyphIndex] = [char]$replacement
          $duplicateVariants.Add((-join $chars))
        }
      }
      foreach ($variant in @($duplicateVariants)) {
        if ($candidateSet.Add($variant)) {
          $orderedCandidates.Add($variant)
        }
        if ($candidateSet.Count -ge 128) { break }
      }
      if ($candidateSet.Count -ge 128) { break }
    }
    foreach ($replacement in @('j', 'J', 'V', 'W', '1', 'I', 'l', 'i')) {
      for ($position = 0; $position -le $joinedAscii.Length; $position += 1) {
        $insertedCandidate = $joinedAscii.Insert($position, $replacement)
        if ($candidateSet.Add($insertedCandidate)) {
          $orderedCandidates.Add($insertedCandidate)
        }
      }
    }
  }
  foreach ($rawCandidate in @($rawCandidates)) {
    foreach ($candidate in @(Add-AmbiguousTextVariants -Text $rawCandidate)) {
      if ($candidateSet.Add($candidate)) {
        $orderedCandidates.Add($candidate)
      }
      if ($candidateSet.Count -ge 128) { break }
    }
    if ($candidateSet.Count -ge 128) { break }
  }

  foreach ($candidate in @($orderedCandidates)) {
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
      Save-AuthenticatedWebSocketKey -Value $candidate
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
  persisted_to_secret_file = $authenticated
  ocr_text_length = $ocrTextLength
  joined_ascii_length = $joinedAsciiLength
  ocr_shape = $ocrShape
} | ConvertTo-Json -Compress

if (-not $authenticated) { exit 2 }
