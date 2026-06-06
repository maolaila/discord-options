param(
  [string]$ChannelId = "",
  [int]$Tail = 20,
  [switch]$Wait,
  [switch]$Full
)

$ErrorActionPreference = "Stop"

chcp.com 65001 | Out-Null
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$global:OutputEncoding = $utf8NoBom

$file = Join-Path $PSScriptRoot "logs\history-messages.ndjson"
if (-not (Test-Path -LiteralPath $file)) {
  throw "History message log does not exist yet: $file"
}

function Convert-LineToRecord {
  param([string]$Line)

  $clean = $Line.Trim()
  if (-not $clean) {
    return $null
  }

  if ($clean[0] -eq [char]0xfeff) {
    $clean = $clean.Substring(1)
  }

  if (-not $clean) {
    return $null
  }

  return $clean | ConvertFrom-Json
}

function Get-FirstEmbed {
  param($Record)

  if ($Record.embeds -and $Record.embeds.Count -gt 0) {
    return $Record.embeds[0]
  }

  return $null
}

function Write-FullRecord {
  param($Record)

  $embed = Get-FirstEmbed -Record $Record
  $author = $Record.author.global_name
  if (-not $author) { $author = $Record.author.username }
  if (-not $author) { $author = $Record.author.id }

  Write-Host "[$($Record.timestamp)] id=$($Record.id) author=$author"
  if ($Record.content) { Write-Host "content: $($Record.content)" }
  if ($embed -and $embed.title) { Write-Host "title: $($embed.title)" }
  if ($embed -and $embed.description) { Write-Host "description: $($embed.description)" }

  if ($embed -and $embed.fields) {
    foreach ($field in $embed.fields) {
      Write-Host "$($field.name): $($field.value)"
    }
  }

  Write-Host ""
}

if ($Wait) {
  Get-Content -LiteralPath $file -Encoding UTF8 -Tail $Tail -Wait | ForEach-Object {
    $record = Convert-LineToRecord -Line $_
    if ($record -and ((-not $ChannelId) -or $record.channel_id -eq $ChannelId)) {
      Write-FullRecord -Record $record
    }
  }
  return
}

$records = Get-Content -LiteralPath $file -Encoding UTF8 -Tail $Tail |
  ForEach-Object { Convert-LineToRecord -Line $_ } |
  Where-Object { $_ -and ((-not $ChannelId) -or $_.channel_id -eq $ChannelId) }

if ($Full) {
  foreach ($record in $records) {
    Write-FullRecord -Record $record
  }
  return
}

$records | ForEach-Object {
  $embed = Get-FirstEmbed -Record $_
  $author = $_.author.global_name
  if (-not $author) { $author = $_.author.username }
  if (-not $author) { $author = $_.author.id }

  [pscustomobject]@{
    time = $_.timestamp
    channel = $_.channel_id
    id = $_.id
    author = $author
    title = if ($embed) { $embed.title } else { "" }
    content = $_.content
  }
} | Format-Table -AutoSize -Wrap
