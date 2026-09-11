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
$temporaryImagePath = Join-Path $RepoRoot 'secrets\.opend-auth-recovery.png'
$imageValidatorPath = Join-Path $RepoRoot 'ops\validate-opend-key-image.ps1'

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

  $seen = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
  )
  $variants = [System.Collections.Generic.List[string]]::new()
  $seen.Add($Text) | Out-Null
  $variants.Add($Text)
  $groups = @(
    @('0', 'O', 'o', 'Q', 'q'),
    @('1', 'I', 'i', 'l', 'L', 'J', 'j'),
    @('2', 'Z', 'z'),
    @('5', 'S', 's'),
    @('8', 'B'),
    @('V', 'U', 'W', 'v', 'u', 'w'),
    @('C', 'G', 'c', 'g'),
    @('X', 'K', 'x', 'k'),
    @('F', 'P', 'f', 'p'),
    @('R', 'P'),
    @('N', 'M', 'n', 'm')
  )

  # Try every one-character OCR ambiguity before combining substitutions.
  # This avoids locking out a correct late-position variant behind an
  # exponential set of earlier combinations.
  for ($index = 0; $index -lt $Text.Length; $index += 1) {
    $current = [string]$Text[$index]
    $group = $groups | Where-Object { $_ -contains $current } | Select-Object -First 1
    if (-not $group) { continue }
    foreach ($replacement in $group) {
      if ($replacement -ceq $current) { continue }
      $chars = $Text.ToCharArray()
      $chars[$index] = [char]$replacement
      $variant = -join $chars
      if ($seen.Add($variant)) {
        $variants.Add($variant)
      }
      if ($variants.Count -ge 128) { return @($variants) }
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
$originalKeyFile = $env:MOOMOO_OPEND_WS_KEY_FILE
$authenticated = $false
$attemptCount = 0
$ocrTextLength = 0
$joinedAsciiLength = 0
$ocrShape = ''
$recoveryDeadline = [DateTimeOffset]::UtcNow.AddSeconds($MaxRuntimeSeconds)
$randomAccessStream = $null
$softwareBitmap = $null

try {
  [OpenDRecoveryWindow]::ShowWindow($window.handle, 9) | Out-Null
  # Keep the credential row on-screen without resizing the DPI-scaled window.
  # The previous fixed screen coordinates only matched one workstation scale
  # and could silently crop an unrelated blank strip after an OpenD restart.
  $captureRelativeTop = [int][Math]::Round($window.original_height * 0.68)
  $captureHeight = [int][Math]::Max(90, [Math]::Round($window.original_height * 0.11))
  # A remembered OpenD position can be partly outside the current desktop
  # after sleep, monitor changes, or a scheduled-task launch. Move it into
  # the primary working area before calculating the credential crop, then
  # restore its original coordinates in finally.
  $workArea = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $maximumLeft = [Math]::Max($workArea.Left, $workArea.Right - $window.original_width)
  $maximumTop = [Math]::Max($workArea.Top, $workArea.Bottom - $window.original_height)
  $targetLeft = [Math]::Min([Math]::Max($window.original_left, $workArea.Left), $maximumLeft)
  $targetTop = [Math]::Min([Math]::Max($window.original_top, $workArea.Top), $maximumTop)
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
  try {
    $scaledGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $scaledGraphics.DrawImage($sourceBitmap, 0, 0, $bitmap.Width, $bitmap.Height)
    # Windows OCR is materially more accurate for this small anti-aliased text
    # when decoding a PNG file than a .NET MemoryStream. Keep the narrow crop
    # only inside the ignored secrets directory. This script removes it in
    # finally, and the parent watchdog also removes it after a forced timeout.
    [IO.Directory]::CreateDirectory((Split-Path -Parent $temporaryImagePath)) | Out-Null
    Remove-Item -LiteralPath $temporaryImagePath -Force -ErrorAction SilentlyContinue
    $bitmap.Save($temporaryImagePath, [Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $scaledGraphics.Dispose()
    $bitmap.Dispose()
    $sourceBitmap.Dispose()
  }

  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
  $storageFile = Await-WindowsRuntimeOperation `
    -Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($temporaryImagePath)) `
    -ResultType ([Windows.Storage.StorageFile])
  $randomAccessStream = Await-WindowsRuntimeOperation `
    -Operation ($storageFile.OpenReadAsync()) `
    -ResultType ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  $decoder = Await-WindowsRuntimeOperation `
    -Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($randomAccessStream)) `
    -ResultType ([Windows.Graphics.Imaging.BitmapDecoder])
  $softwareBitmap = Await-WindowsRuntimeOperation `
    -Operation ($decoder.GetSoftwareBitmapAsync()) `
    -ResultType ([Windows.Graphics.Imaging.SoftwareBitmap])
  $ocrEngines = [System.Collections.Generic.List[object]]::new()
  $ocrEngines.Add([Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage(
    [Windows.Globalization.Language]::new('en-US')
  ))
  $ocrEngines.Add([Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages())
  $ocrTexts = [System.Collections.Generic.List[string]]::new()
  foreach ($ocrEngine in $ocrEngines) {
    if ($null -eq $ocrEngine) { continue }
    $ocrResult = Await-WindowsRuntimeOperation `
      -Operation ($ocrEngine.RecognizeAsync($softwareBitmap)) `
      -ResultType ([Windows.Media.Ocr.OcrResult])
    $ocrTexts.Add([string]$ocrResult.Text)
  }
  # Reopen the encoded crop for one independent OCR pass. Windows OCR can
  # occasionally return a different token when the first decoder instance was
  # created immediately after the PNG write; the reopened pass is the same path
  # used by the successful standalone validation.
  $softwareBitmap.Dispose()
  $softwareBitmap = $null
  $randomAccessStream.Dispose()
  $randomAccessStream = $null
  Start-Sleep -Milliseconds 250
  $storageFile = Await-WindowsRuntimeOperation `
    -Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($temporaryImagePath)) `
    -ResultType ([Windows.Storage.StorageFile])
  $randomAccessStream = Await-WindowsRuntimeOperation `
    -Operation ($storageFile.OpenReadAsync()) `
    -ResultType ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  $decoder = Await-WindowsRuntimeOperation `
    -Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($randomAccessStream)) `
    -ResultType ([Windows.Graphics.Imaging.BitmapDecoder])
  $softwareBitmap = Await-WindowsRuntimeOperation `
    -Operation ($decoder.GetSoftwareBitmapAsync()) `
    -ResultType ([Windows.Graphics.Imaging.SoftwareBitmap])
  $repeatOcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  $repeatOcrResult = Await-WindowsRuntimeOperation `
    -Operation ($repeatOcrEngine.RecognizeAsync($softwareBitmap)) `
    -ResultType ([Windows.Media.Ocr.OcrResult])
  # This reopened user-profile pass most closely matches the UI glyphs and is
  # therefore tried before the English and first-decoder fallbacks. A wrong
  # first login can cause OpenD to reject immediately following candidates.
  $ocrTexts.Insert(0, [string]$repeatOcrResult.Text)
  if ($ocrTexts.Count -eq 0) { throw 'No Windows OCR engine was available.' }
  $ocrTextLength = $ocrTexts[0].Length
  $ocrShape = -join @($ocrTexts[0].ToCharArray() | ForEach-Object {
    if ($_ -cmatch '[A-Z]') { 'U' }
    elseif ($_ -cmatch '[a-z]') { 'L' }
    elseif ($_ -match '[0-9]') { 'D' }
    elseif ([char]::IsWhiteSpace($_)) { 'S' }
    else { 'X' }
  })

  $rawCandidates = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
  )
  $joinedAsciiCandidates = [System.Collections.Generic.List[string]]::new()
  foreach ($ocrText in $ocrTexts) {
    @(
      [regex]::Matches(
        $ocrText,
        '(?<![A-Za-z0-9])[A-Za-z0-9]{16}(?![A-Za-z0-9])'
      ) | ForEach-Object { $_.Value }
    ) | ForEach-Object { $rawCandidates.Add($_) | Out-Null }
    $compactOcrText = [regex]::Replace($ocrText, '\s', '')
    if ($compactOcrText.Length -eq 16 -and $compactOcrText -match '[^A-Za-z0-9]') {
      # OCR commonly renders a narrow key character as punctuation. Preserve its
      # position and try a small bounded replacement set instead of deleting it.
      foreach ($replacement in @('0', 'O', 'o', '1', 'I', 'i', 'l', 'j', 'J')) {
        $rawCandidates.Add(
          ([regex]::Replace($compactOcrText, '[^A-Za-z0-9]', $replacement))
        ) | Out-Null
      }
    }
    $joinedCandidate = [regex]::Replace($ocrText, '[^A-Za-z0-9]', '')
    $joinedAsciiCandidates.Add($joinedCandidate)
    if ($joinedCandidate.Length -ge 16) {
      for ($start = 0; $start -le $joinedCandidate.Length - 16; $start += 1) {
        $rawCandidates.Add($joinedCandidate.Substring($start, 16)) | Out-Null
      }
    }
  }
  $joinedAscii = $joinedAsciiCandidates[0]
  $joinedAsciiLength = $joinedAscii.Length
  $candidateSet = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
  )
  $orderedCandidates = [System.Collections.Generic.List[string]]::new()
  foreach ($joinedCandidate in $joinedAsciiCandidates) {
    if ($joinedCandidate.Length -eq 16 -and $candidateSet.Add($joinedCandidate)) {
      # Bypass collection-enumeration ambiguity and test complete OCR tokens
      # first. The variants below are only fallbacks for failed exact probes.
      $orderedCandidates.Add($joinedCandidate)
      # OpenD can reject a login attempted immediately after its window is
      # restored or after another health connection closes. Retry the exact
      # OCR token once after a short cooldown before trying altered variants.
      $orderedCandidates.Add($joinedCandidate)
    }
  }
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
    # The OCR text is usually exact. Test it before generating ambiguity
    # variants so a correct credential is not delayed behind failed logins.
    if ($candidateSet.Add($rawCandidate)) {
      $orderedCandidates.Add($rawCandidate)
    }
    foreach ($candidate in @(Add-AmbiguousTextVariants -Text $rawCandidate)) {
      if ($candidateSet.Add($candidate)) {
        $orderedCandidates.Add($candidate)
      }
      if ($candidateSet.Count -ge 128) { break }
    }
    if ($candidateSet.Count -ge 128) { break }
  }

  # The credential crop is complete. Restore the OpenD window before opening
  # probe connections; some builds transiently reject WebSocket logins while
  # their profile window is held topmost by another process.
  [OpenDRecoveryWindow]::SetWindowPos(
    $window.handle,
    $notTopMost,
    $window.original_left,
    $window.original_top,
    $window.original_width,
    $window.original_height,
    $showWindow
  ) | Out-Null
  Start-Sleep -Seconds 1

  # Run the exact OCR validation in a fresh process. This avoids a Windows OCR
  # state issue observed when capture and recognition share the same long-lived
  # PowerShell process. No credential is passed through arguments or output.
  $validator = Start-Process `
    -FilePath (Join-Path $PSHOME 'powershell.exe') `
    -ArgumentList @(
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', ('"{0}"' -f $imageValidatorPath),
      '-RepoRoot', ('"{0}"' -f $RepoRoot),
      '-ImagePath', ('"{0}"' -f $temporaryImagePath)
    ) `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru `
    -Wait
  if ($validator.ExitCode -eq 0) {
    $authenticated = $true
  }

  if (-not $authenticated) {
    $previousCandidate = $null
    foreach ($candidate in @($orderedCandidates)) {
    $remainingSeconds = ($recoveryDeadline - [DateTimeOffset]::UtcNow).TotalSeconds
    if ($remainingSeconds -le 1) { break }
    if ($null -ne $previousCandidate -and $candidate -ceq $previousCandidate) {
      Start-Sleep -Seconds 2
    }
    $previousCandidate = $candidate
    $attemptCount += 1
    # Normal runtimes intentionally prefer the .env-selected shared key file.
    # During this bounded recovery probe only, mask that file setting inside the
    # child environment so the candidate being tested is the actual credential.
    # A single space keeps dotenv override=false from restoring the file path;
    # the runtime trims it and then uses the direct, process-scoped candidate.
    $env:MOOMOO_OPEND_WS_KEY_FILE = ' '
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
  if ($null -eq $originalKeyFile) {
    Remove-Item Env:MOOMOO_OPEND_WS_KEY_FILE -ErrorAction SilentlyContinue
  } else {
    $env:MOOMOO_OPEND_WS_KEY_FILE = $originalKeyFile
  }
  if ($null -ne $softwareBitmap) { $softwareBitmap.Dispose() }
  if ($null -ne $randomAccessStream) { $randomAccessStream.Dispose() }
  Remove-Item -LiteralPath $temporaryImagePath -Force -ErrorAction SilentlyContinue
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
