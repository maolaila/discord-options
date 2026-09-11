[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [Parameter(Mandatory = $true)][string]$ImagePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$ImagePath = [IO.Path]::GetFullPath($ImagePath)
$secretsRoot = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'secrets')) + [IO.Path]::DirectorySeparatorChar
if (-not $ImagePath.StartsWith($secretsRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The OpenD credential image must be inside the repository secrets directory.'
}

$envPath = Join-Path $RepoRoot '.env'
$checkScript = Join-Path $RepoRoot 'apps\opend-check\moomoo-check.mjs'
$probeStdout = Join-Path $RepoRoot 'logs\.opend-image-probe.stdout.log'
$probeStderr = Join-Path $RepoRoot 'logs\.opend-image-probe.stderr.log'

function Await-WindowsRuntimeOperation {
  param([Parameter(Mandatory = $true)]$Operation, [Parameter(Mandatory = $true)][Type]$ResultType)
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}

function Resolve-KeyFilePath {
  $configured = 'secrets\moomoo_opend_ws_key.txt'
  foreach ($line in Get-Content -LiteralPath $envPath -ErrorAction Stop) {
    if ($line -match '^\s*MOOMOO_OPEND_WS_KEY_FILE\s*=\s*(.*?)\s*$') {
      $configured = ([string]$Matches[1]).Trim().Trim('"').Trim("'")
      break
    }
  }
  $resolved = if ([IO.Path]::IsPathRooted($configured)) {
    [IO.Path]::GetFullPath($configured)
  } else {
    [IO.Path]::GetFullPath((Join-Path $RepoRoot $configured))
  }
  if (-not $resolved.StartsWith($secretsRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'MOOMOO_OPEND_WS_KEY_FILE must resolve inside the repository secrets directory.'
  }
  return $resolved
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
$file = Await-WindowsRuntimeOperation `
  -Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) `
  -ResultType ([Windows.Storage.StorageFile])
$stream = Await-WindowsRuntimeOperation `
  -Operation ($file.OpenReadAsync()) `
  -ResultType ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
$bitmap = $null
$originalDirectKey = $env:MOOMOO_OPEND_WS_KEY
$originalKeyFile = $env:MOOMOO_OPEND_WS_KEY_FILE
try {
  $decoder = Await-WindowsRuntimeOperation `
    -Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) `
    -ResultType ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-WindowsRuntimeOperation `
    -Operation ($decoder.GetSoftwareBitmapAsync()) `
    -ResultType ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  $result = Await-WindowsRuntimeOperation `
    -Operation ($engine.RecognizeAsync($bitmap)) `
    -ResultType ([Windows.Media.Ocr.OcrResult])
  $candidate = [regex]::Replace([string]$result.Text, '[^A-Za-z0-9]', '')
  if ($candidate.Length -ne 16) { exit 2 }

  # The candidate exists only in this helper and its bounded probe child.
  $env:MOOMOO_OPEND_WS_KEY_FILE = ' '
  $env:MOOMOO_OPEND_WS_KEY = $candidate
  Remove-Item -LiteralPath $probeStdout, $probeStderr -Force -ErrorAction SilentlyContinue
  $probe = Start-Process `
    -FilePath (Get-Command node -ErrorAction Stop).Source `
    -ArgumentList ('"{0}"' -f $checkScript) `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $probeStdout `
    -RedirectStandardError $probeStderr `
    -PassThru `
    -Wait
  if ($probe.ExitCode -ne 0) { exit 3 }

  $keyFilePath = Resolve-KeyFilePath
  [IO.Directory]::CreateDirectory((Split-Path -Parent $keyFilePath)) | Out-Null
  [IO.File]::WriteAllText($keyFilePath, $candidate + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  exit 0
} finally {
  if ($null -ne $bitmap) { $bitmap.Dispose() }
  $stream.Dispose()
  if ($null -eq $originalDirectKey) { Remove-Item Env:MOOMOO_OPEND_WS_KEY -ErrorAction SilentlyContinue } else { $env:MOOMOO_OPEND_WS_KEY = $originalDirectKey }
  if ($null -eq $originalKeyFile) { Remove-Item Env:MOOMOO_OPEND_WS_KEY_FILE -ErrorAction SilentlyContinue } else { $env:MOOMOO_OPEND_WS_KEY_FILE = $originalKeyFile }
  Remove-Item -LiteralPath $probeStdout, $probeStderr -Force -ErrorAction SilentlyContinue
}
