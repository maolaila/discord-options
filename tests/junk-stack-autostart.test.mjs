import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const powershell = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const stackPath = path.join(root, 'run-junk-stack.ps1');
const autostartPath = path.join(root, 'ops', 'install-junk-stack-autostart.ps1');
const discordBrowserPath = path.join(root, 'start-discord-cdp.ps1');
const authRecoveryPath = path.join(root, 'ops', 'recover-opend-websocket-auth.ps1');
const imageValidatorPath = path.join(root, 'ops', 'validate-opend-key-image.ps1');

function parsePowerShell(filePath) {
  return spawnSync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, POWERSHELL_FILE: filePath },
      input: String.raw`
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  $env:POWERSHELL_FILE,
  [ref]$tokens,
  [ref]$errors
) | Out-Null
if ($errors.Count -gt 0) {
  $errors | ForEach-Object { Write-Error $_.Message }
  exit 1
}
`,
      timeout: 30_000,
    },
  );
}

test('long-running stack PowerShell entrypoints parse', () => {
  for (const filePath of [stackPath, autostartPath, discordBrowserPath, authRecoveryPath, imageValidatorPath]) {
    const result = parsePowerShell(filePath);
    assert.equal(result.status, 0, `${filePath}\n${result.stdout}\n${result.stderr}`);
  }
});

test('autostart is hidden, long-running, and has a low-frequency recovery trigger', () => {
  const source = readFileSync(autostartPath, 'utf8');
  assert.match(source, /New-ScheduledTaskTrigger\s+-AtLogOn/);
  assert.match(source, /\[int\]\$WatchdogIntervalMinutes = 5/);
  assert.match(source, /-RepetitionInterval \(New-TimeSpan -Minutes \$WatchdogIntervalMinutes\)/);
  assert.match(source, /\$triggers = @\(\$logonTrigger, \$watchdogTrigger\)/);
  assert.match(source, /-WindowStyle Hidden/);
  assert.match(source, /-MultipleInstances IgnoreNew/);
  assert.match(source, /-RestartCount 999/);
  assert.match(source, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.doesNotMatch(source, /WatchdogIntervalMinutes = 1/);
});

test('dedicated Discord browser opens the JUNKMAN analysis channel', () => {
  const source = readFileSync(discordBrowserPath, 'utf8');
  assert.match(source, /https:\/\/discord\.com\/channels\/1434960637561409689\/1515786763417813094/);
  assert.match(source, /--start-minimized/);
});

test('top supervisor requires live Gateway health, not merely a capture process', () => {
  const source = readFileSync(stackPath, 'utf8');
  assert.match(source, /Get-ConsoleCaptureHealthAssessment/);
  assert.match(source, /capture_health/);
  assert.match(source, /captureRunning -and \$captureAssessment\.Healthy/);
  assert.match(source, /Discord Gateway capture is unhealthy; restarting/);
});

test('OpenD recovery probes each OCR candidate instead of the stale shared key file', () => {
  const source = readFileSync(authRecoveryPath, 'utf8');
  assert.match(source, /\$originalKeyFile = \$env:MOOMOO_OPEND_WS_KEY_FILE/);
  assert.match(source, /\$env:MOOMOO_OPEND_WS_KEY_FILE = ' '/);
  assert.match(source, /\$env:MOOMOO_OPEND_WS_KEY = \$candidate/);
  assert.match(source, /\$env:MOOMOO_OPEND_WS_KEY_FILE = \$originalKeyFile/);
  assert.match(source, /\[Windows\.Forms\.Screen\]::PrimaryScreen\.WorkingArea/);
  assert.match(source, /\$candidateSet\.Add\(\$rawCandidate\)/);
  assert.match(source, /every one-character OCR ambiguity/);
  assert.match(source, /TryCreateFromLanguage/);
  assert.match(source, /Reopen the encoded crop/);
  assert.match(source, /\$ocrTexts\.Insert\(0/);
  assert.match(source, /validate-opend-key-image\.ps1/);
  assert.match(source, /No credential is passed through arguments or output/);
  assert.match(source, /test complete OCR tokens/);
  assert.match(source, /Retry the exact/);
  assert.match(source, /Restore the OpenD window before opening/);
  assert.match(source, /secrets\\\.opend-auth-recovery\.png/);
  assert.match(source, /Windows OCR is materially more accurate/);
});

test('isolated image validator keeps the candidate out of arguments and stdout', () => {
  const source = readFileSync(imageValidatorPath, 'utf8');
  assert.match(source, /\$env:MOOMOO_OPEND_WS_KEY = \$candidate/);
  assert.match(source, /WriteAllText\(\$keyFilePath, \$candidate/);
  assert.doesNotMatch(source, /Write-(?:Output|Host).*candidate|console\.log/);
});
