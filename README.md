# JUNKMAN SPX 0DTE Simulation System

This repository contains one trading strategy only: JUNKMAN. Nightwatch Data API supplies SPX Dealer GEX, Heatmap, and option-structure evidence. Moomoo OpenD supplies price confirmation, option quotes, and simulated-account execution. Discord `0dte-flow-alert` is optional context and can never trigger or veto a trade by itself.

The system is simulation-only. `config/zero-dte-options-policy.json` sets `environment=simulate_only` and `real_trading_allowed=false`, and the JUNKMAN entrypoint also rejects real-account execution in code. The repository provides no real-trading command.

## Architecture

- `apps/zero-dte-options/`: JUNKMAN v3 decisions, recovery, entry, exit, and the seven-line experiment.
- `apps/discord-capture/`: attaches to a local browser, archives Discord messages, and identifies automated `0dte-flow-alert` events.
- `apps/opend-check/`: verifies OpenD connectivity and the simulated option account.
- `apps/control-console/`: local runtime status and controls.
- `packages/nightwatch-api/`: Nightwatch REST client with a one-request-per-second floor and `Retry-After` backoff.
- `packages/moomoo-opend/`: shared OpenD quote, account, and simulated-order functions.
- `packages/option-signals/`: strict automated Nightwatch Flow parser.
- `packages/business-lines/`: metadata for the only business line, `zero-dte-options`.
- `config/zero-dte-options-policy.json`: the only strategy and risk policy.

Nightwatch GEX and Heatmap are structural evidence. Moomoo SPY one-minute pushes are aggregated into completed five-minute bars for price, volume, and node-reaction confirmation. The strategy decides only after a five-minute bar closes. OI, Flow color, and a single Sweep are never standalone directional signals.

The daily OI research layer reads `options.oi_change` and the optional `options.options_volume` aggregate once per open session. It preserves the activity trade date separately from the OI effective date, keeps unknown values as `null`, and builds exact-contract plus strike/right histories over 3, 5, and 10 sessions. This layer is settlement-lagged background only: it cannot create, confirm, reject, or resize an intraday trade. Its SQLite research database and redacted source snapshots remain local under `data/junk-oi-research/`; Broker recovery and exit reconciliation always run before any daily OI refresh.

For automated Flow, green means Call, red means Put, and the buy label means execution on the ask side. None of these proves whether a position was opened or closed, or its final direction. Only live 0DTE SPX events from the configured guild, channel, and bot can add optional support after they pass lag, premium, OTM, Sweep, repeated-strike, and data-quality checks. SPY Flow is audit-only. REST backfill and stale events are not trade-eligible.

## Install and configure

Requirements:

- Windows
- Node.js 24.15 or newer (Node 24 LTS is recommended; JUNKMAN uses the built-in `node:sqlite` module)
- Chrome or Edge
- Moomoo desktop and OpenD, logged in with the WebSocket API enabled

```powershell
npm install
Copy-Item .\.env.example .\.env
```

Keep `.env` local. It contains only machine-specific OpenD settings and must retain `MOOMOO_TRD_ENV=simulate` and `MOOMOO_ALLOW_REAL_TRADING=false`.

If OpenD uses a WebSocket key, store it in an ignored local file:

```powershell
New-Item -ItemType Directory -Force .\secrets
notepad .\secrets\moomoo_opend_ws_key.txt
```

Never place the Nightwatch key in `.env`, source code, logs, or Git history. Store it only in the Windows user environment:

```powershell
[Environment]::SetEnvironmentVariable('YEHANGSHE_API_KEY', '<your-key>', 'User')
```

Open a new PowerShell window, then verify both providers:

```powershell
npm run nightwatch:discover
npm run moomoo:check
```

`nightwatch:discover` should return available datasets and `quota.monthly_remaining`. `moomoo:check` should confirm the OpenD connection, quote and trade login, and a `trdEnv=0` simulated account that supports US options.

## Optional Discord Flow capture

The main strategy runs from Nightwatch API evidence and moomoo market data without Discord Flow. To add live auxiliary Flow context:

```powershell
.\start-discord-cdp.ps1
npm run capture
```

Log into Discord in the opened browser. After the capture process prints `Attached`, refresh the Discord tab once so compressed Gateway WebSocket decoding starts at the beginning of the connection.

The capture process does not click or control the page, actively call Discord APIs, or read and print tokens, cookies, request headers, or Authorization values.

Useful checks:

```powershell
.\show-capture-status.ps1
Get-Content .\logs\messages.ndjson -Encoding UTF8 -Wait
Get-Content .\logs\history-messages.ndjson -Encoding UTF8 -Wait
```

Only strictly matching automated Flow is written to `logs/zero-dte-options-flow-events.ndjson`. Ordinary chat, manual Flow, history backfill, and late events cannot trigger a JUNKMAN trade.

## Run JUNKMAN

Start with read-only status and planning commands:

```powershell
npm run junk:gex:status
npm run junk:gex:plan
```

Use the top-level stack supervisor for continuous simulated monitoring and trading:

```powershell
.\run-junk-stack.ps1
```

It verifies the real OpenD API login and simulated US-option account before starting JUNKMAN, restores the console and Discord capture, and delegates the strategy process to `run-junk-gex.ps1`. The unattended setup starts the top-level supervisor once at sign-in; the supervisor then performs continuous health checks without a repeating PowerShell task. For foreground debugging only:

```powershell
npm run junk:gex:watch-sim
```

Start the local control console with:

```powershell
.\start-console.ps1
```

Its default URL is `http://127.0.0.1:18766`. The console manages the browser, capture process, and OpenD checks needed by JUNKMAN, and displays JUNKMAN status. `run-junk-gex.ps1` remains the authoritative strategy child supervisor.

For unattended Windows operation, run the following once from an elevated PowerShell and approve UAC:

```powershell
.\ops\windows-unattended-hardening.ps1
```

This disables supported automatic updater services/tasks, keeps lid close and idle sleep from suspending the stack, and registers a sign-in-only top-level stack task. It deliberately retains thermal protection, critical-battery hibernation, Defender, and crash recovery. No software can guarantee continuity through power loss, hardware failure, or an unavailable network.

## Strategy and risk rules

The effective rules live in `config/zero-dte-options-policy.json`:

- The strategy trades single-leg SPX 0DTE options in simulation only.
- It allows at most one open position and three entries per day.
- Each experiment line has USD 10,000 of simulated equity. Target allocation is 5% and 10% is a soft sizing target: when one contract costs more than 10% but no more than the full USD 10,000 line, the line buys the minimum one contract.
- Positive Gamma is treated as range or magnet structure; the strategy does not chase a naked single leg in the center.
- Negative Gamma acceleration requires a confirmed breakout and retest.
- Entry requires stable GEX nodes, a completed five-minute price reaction, VWAP and volume confirmation, price between invalidation and target, and acceptable bid/ask, spread, OI, and option volume.
- Shared exits include structural invalidation, the next GEX node, a five-minute no-progress rule, breakeven protection after a 20% option gain, and the 15:30/15:45 ET close discipline.
- The control catastrophic stop is -15% and has no fixed take-profit. Structural exits take priority over fixed percentage exits.
- The system never holds overnight.
- Nightwatch timeout, quota protection, or HTTP 429 backoff cannot block moomoo position reconciliation, stop handling, or time exits for an existing position.

## Seven paired exit variants

One signal, contract, entry time, and fill price create one aggregate position in the moomoo simulated account. The program assigns that position to seven local virtual portfolios. Each line has USD 10,000, for a USD 70,000 total experiment baseline. Only fixed take-profit and catastrophic-stop settings differ:

| line_id | Stop | Fixed take-profit |
| --- | ---: | ---: |
| `control_sl15_tp_off` | -15% | Off |
| `sl10_tp_off` | -10% | Off |
| `sl10_tp20` | -10% | +20% |
| `sl10_tp30` | -10% | +30% |
| `sl15_tp20` | -15% | +20% |
| `sl15_tp30` | -15% | +30% |
| `sl12p5_tp25` | -12.5% | +25% |

Shared structural exits, the five-minute no-progress rule, breakeven behavior, and close discipline are frozen when a cohort is created. An aggregate entry is allocated only after complete equal-unit fills. Any remainder is closed immediately. A broker-to-ledger quantity mismatch stops new actions. A cohort affected by partial exit fills is recorded but excluded from the comparable leaderboard.

## Status and trade records

All JUNKMAN state uses the `zero-dte-options` prefix:

- `logs/zero-dte-options-status.json`: heartbeat, mode, provider, and error state.
- `logs/zero-dte-options-runtime-state.json`: positions, orders, recovery, and exit state.
- `logs/zero-dte-options-decisions.ndjson`: strategy gate decisions.
- `logs/zero-dte-options-entry-plans.ndjson`: entry plans and rejection reasons.
- `logs/zero-dte-options-exit-plans.ndjson`: exit plans and trigger reasons.
- `logs/zero-dte-options-trades.ndjson`: simulated orders, fills, exits, and realized results.
- `logs/zero-dte-options-flow-events.ndjson`: automated Flow parsing and eligibility audit.
- `logs/zero-dte-options-experiment-events.ndjson`: per-cohort and per-line events.
- `logs/zero-dte-options-experiment-summary.json`: per-line realized and comparable PnL, win rate, and sample count.
- `logs/zero-dte-options-oi-structure-background.json`: compact, non-directional OI research context used in decision audits.
- `data/junk-oi-research/`: ignored local SQLite history and redacted daily source snapshots.

Runtime data normally remains local. At explicit audit points, the repository may include a reviewed snapshot of `zero-dte-options-trades.ndjson`; other dynamic logs remain ignored. Trade records must not contain account IDs, API keys, Bearer values, cookies, or browser tokens.

Strategy evidence, attributed source material, and engineering boundaries are documented in `docs/junkman-strategy-v3-evidence-2026-08-11.md`.

## Safety and repository boundaries

The repository may contain source code, tests, the JUNKMAN policy, launch scripts, documentation, and a reviewed JUNKMAN trade-record snapshot. Never commit:

- `.env` or any API key, Bearer value, or account secret
- `secrets/` or `profile/`
- unreviewed runtime logs, private Discord content, or account details

See `NEW_DEVICE_SETUP.md` for migration steps.
