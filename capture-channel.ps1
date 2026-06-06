param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CaptureArgs
)

$ErrorActionPreference = "Stop"

& "$PSScriptRoot\run-capture.ps1" @CaptureArgs
