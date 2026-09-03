# New Device Setup

This guide deploys the JUNKMAN SPX 0DTE simulation system on another Windows computer. Git transfers the program, tests, strategy policy, documentation, and reviewed trade-record snapshots. Discord login state, the Nightwatch key, the OpenD key, and live runtime state must be configured locally on the new device.

## 1. Install prerequisites

Install:

- Git
- Node.js 24.15 or newer (use the latest Node 24 LTS patch release)
- Chrome or Edge
- Moomoo desktop and OpenD, logged in with the WebSocket API enabled

Clone and install:

```powershell
git clone https://github.com/maolaila/discord-options.git
cd discord-options
npm install
```

Verify the effective Node.js version:

```powershell
node --version
```

The JUNKMAN supervisor rejects Node.js versions below 20.

## 2. Configure OpenD

Create the local environment file:

```powershell
Copy-Item .\.env.example .\.env
notepad .\.env
```

Keep at least these values:

```text
MOOMOO_OPEND_HOST=127.0.0.1
MOOMOO_OPEND_WS_PORT=33333
MOOMOO_OPEND_WS_SSL=false
MOOMOO_OPEND_WS_KEY_FILE=./secrets/moomoo_opend_ws_key.txt
MOOMOO_TRD_ENV=simulate
MOOMOO_TRD_MARKET=US
MOOMOO_ALLOW_REAL_TRADING=false
```

If OpenD has a WebSocket key, place it in this ignored local file. Every JUNKMAN
process reads this same file; do not add a separate direct-key environment value:

```powershell
New-Item -ItemType Directory -Force .\secrets
notepad .\secrets\moomoo_opend_ws_key.txt
```

Start Moomoo and OpenD, then verify connectivity:

```powershell
npm run moomoo:check
```

The output should confirm the OpenD connection, `qotLogined=true`, `trdLogined=true`, and at least one `trdEnv=0` simulated account that supports US options. Do not put a real account ID in the policy. JUNKMAN selects a compatible simulated option account from the accounts returned by OpenD.

## 3. Configure Nightwatch

Store the Nightwatch key only in the Windows user environment, never in project `.env`:

```powershell
[Environment]::SetEnvironmentVariable('YEHANGSHE_API_KEY', '<your-key>', 'User')
```

Close and reopen PowerShell, then verify access:

```powershell
npm run nightwatch:discover
```

Confirm that the response includes the available datasets and `quota.monthly_remaining`. Snapshot polling has a one-request-per-second minimum interval. HTTP 429 responses follow `Retry-After` backoff.

## 4. Optional Discord Flow context

The main strategy uses Nightwatch API evidence and moomoo market data; it does not depend on Discord Flow. To archive `0dte-flow-alert` and use eligible live events as optional confirmation context:

```powershell
.\start-discord-cdp.ps1
npm run capture
```

Log into Discord in the opened browser. After the capture process prints `Attached`, refresh the Discord tab once so compressed Gateway WebSocket decoding begins at the start of the connection. Login state remains local in `profile/`.

Check capture health with:

```powershell
.\show-capture-status.ps1
```

Flow cannot create or veto a trade by itself. History backfill, delayed messages, manually posted content, and messages from any nonconfigured bot are archive-only.

## 5. Start and verify JUNKMAN

Check current status and run a dry plan first:

```powershell
npm run junk:gex:status
npm run junk:gex:plan
```

Use the top-level stack supervisor for continuous simulated trading:

```powershell
.\run-junk-stack.ps1
```

It verifies OpenD API authentication and the simulated US-option account, restores capture/console dependencies, and starts the single-instance strategy child supervisor. For foreground debugging only:

```powershell
npm run junk:gex:watch-sim
```

Start the local console with:

```powershell
.\start-console.ps1
```

The default URL is `http://127.0.0.1:18766`.

For unattended use, approve UAC once from an elevated PowerShell:

```powershell
.\ops\windows-unattended-hardening.ps1
```

The script registers a sign-in-only stack task and disables supported automatic updater services/tasks without disabling thermal protection, critical-battery hibernation, Defender, or crash recovery. Continuous health checks run inside the long-lived stack supervisor, without a repeating PowerShell task.

Verify runtime state and recent records:

```powershell
npm run junk:gex:status
Get-Content .\logs\zero-dte-options-supervisor.log -Encoding UTF8 -Tail 30
Get-Content .\logs\zero-dte-options-trades.ndjson -Encoding UTF8 -Tail 20
```

The effective mode must be `simulate_only`. No real-account order should exist.

## 6. Seven-line exit experiment

One aggregate moomoo simulated position backs seven local virtual portfolios. Every line shares the same signal, contract, entry time, and fill price. Each line has USD 10,000 and differs only in its fixed stop and take-profit pair:

- `SL15 / TP off` control
- `SL10 / TP off`
- `SL10 / TP20`
- `SL10 / TP30`
- `SL15 / TP20`
- `SL15 / TP30`
- `SL12.5 / TP25`

Structural exits, the five-minute no-progress rule, breakeven protection after a 20% gain, and the close discipline are shared by all lines. Experiment events are written to `logs/zero-dte-options-experiment-events.ndjson`; aggregate metrics are written to `logs/zero-dte-options-experiment-summary.json`.

## 7. Local-only data

These items are recreated or configured locally and normally do not move with Git:

- `.env`: machine-specific OpenD settings
- `secrets/`: OpenD WebSocket key
- `profile/`: Discord browser login state
- `logs/`: runtime state, decisions, orders, Flow events, and experiment events; only a reviewed JUNKMAN trade-record snapshot is explicitly committed

Never commit an API key, Bearer value, cookie, browser token, account ID, or private raw Discord content.

## Safety boundary

JUNKMAN permits moomoo simulation only. The policy must keep `real_trading_allowed=false`; `.env` must keep `MOOMOO_TRD_ENV=simulate` and `MOOMOO_ALLOW_REAL_TRADING=false`. The repository has no real-trading command. Do not add or bypass one.
