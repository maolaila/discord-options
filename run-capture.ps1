param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CaptureArgs
)

$ErrorActionPreference = "Stop"

chcp.com 65001 | Out-Null
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$global:OutputEncoding = $utf8NoBom

node "$PSScriptRoot\capture-discord.js" @CaptureArgs
