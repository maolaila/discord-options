# JUNKMAN SPX 0DTE Simulation System

Only the JUNK main (SPX 0DTE) trading line is enabled. It uses Nightwatch Dealer GEX, Heatmap and option-structure evidence with Moomoo OpenD simulated execution. MULTI and Flow plus Heatmap are retired: their startup commands are disabled, and the live console/performance report shows only JUNK main. Historical implementations, logs and review exports are retained for audit, not deleted.

The system is simulation-only. `config/zero-dte-options-policy.json` sets `environment=simulate_only` and `real_trading_allowed=false`, and the JUNKMAN entrypoint also rejects real-account execution in code. The repository provides no real-trading command.

## Architecture

- `apps/zero-dte-options/`: JUNKMAN v3 decisions, recovery, entry, exit, and the three-line experiment.
- `apps/junk-multi-options/`: deterministic execution of the current-session `junkman-analysis` plans.
- `apps/junk-flow-heatmap-options/`: independent unusual-Flow plus Heatmap experiment.
- `apps/discord-capture/`: attaches to a local browser, archives Discord messages, identifies automated `0dte-flow-alert` events, and normalizes `junkman-analysis` plans.
- `apps/opend-check/`: verifies OpenD connectivity and the simulated option account.
- `apps/control-console/`: local runtime status and controls.
- `packages/nightwatch-api/`: Nightwatch REST client with a one-request-per-second floor and `Retry-After` backoff.
- `packages/moomoo-opend/`: shared OpenD quote, account, and simulated-order functions.
- `packages/option-signals/`: strict parsers for automated Nightwatch Flow and the daily analysis plans.
- `packages/business-lines/`: metadata for the active main line and two retired historical lines.
- `config/`: the active SPX simulation policy and archived MULTI/Flow policies.

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

## Discord capture

For historical context, the retired MULTI line required live capture of `junkman-analysis`; the Flow plus Heatmap line uses the automated Flow feed. Start the shared capture stack with:

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

Only strictly matching automated Flow is written to `logs/zero-dte-options-flow-events.ndjson`. Complete detailed plans from the configured analysis channel and author are normalized into `logs/junkman-analysis-plans.ndjson`. MULTI accepts only the current New York trading day's plans; old, partial, unsupported, wrong-channel, and wrong-author messages cannot become candidates.

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

It verifies the real OpenD API login and simulated US-option account before starting JUNKMAN, restores the console and Discord capture, and delegates only to the SPX main supervisor. The unattended setup starts the top-level supervisor once at sign-in; the supervisor then performs continuous health checks without a repeating PowerShell task. For foreground debugging only:

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
- The current executor manages at most one JUNK-owned aggregate cohort at a time. The former three-entries-per-day gate is disabled because it was not a JUNKMAN rule.
- Each experiment line has USD 10,000 of simulated equity. Target allocation is 5% and 10% is a soft sizing target: when one contract costs more than 10% but no more than the full USD 10,000 line, the line buys the minimum one contract.
- A ranked node's positive/negative Gamma sign is context, not a direction label or veto. Direction comes from a completed price reaction at the node.
- A breakout entry needs a completed body break and a later completed five-minute wick retest that reaches the node while intervening closes hold the accepted side. A same-side rejection needs one completed reverse-colour five-minute candle whose wick reaches the node. Because the provider does not publish a node-region width, the implementation does not invent a point tolerance.
- GEX history and VWAP are recorded for review but do not silently block a confirmed reaction. Real positive volume must be present, but no undocumented volume ratio, body size, displacement, drift, cooldown, or node-history count is imposed. The only structural reward gate is the engineering minimum `reward > risk`, a deliberately weaker formalization of Nightwatch's qualitative advice that near-1:1 setups are usually insufficient.
- Directional option strikes use a same-expiry, same-right gross Gamma-OI ranking proxy from the observed official Nightwatch chain response. JUNKMAN stated a maximum directional GEX strike with a +/-5–10 adjustment, but did not specify the sign convention; choosing 5 points toward current price is therefore labeled as a transparent engineering heuristic, not attributed to him or the API. Dealer GEX net nodes are never treated as an undocumented Call/Put split. The same full-chain response is reused for candidate audit, so one setup does not pay for the identical request twice.
- Execution requires a current quote with real bid/ask and tick plus enough displayed ask depth. OI and day volume remain logged context but are not hard entry gates because neither JUNKMAN nor the official execution API provides a minimum. The former hard 20% spread, 25% round-trip-loss, OI 100, volume 100, per-line contract cap, three-trades-per-day, and USD 300 daily-loss gates are disabled. The remaining modeled immediate-loss rejection uses -15%, an engineering choice at the upper edge of JUNKMAN's stated 10–15% stop range.
- The five-minute no-progress exit is scoped only to a two-boundary `range_mean_reversion` setup: after touching one boundary, exit if the other boundary is not reached within five minutes, regardless of option PnL. The current automated entry model does not emit that setup, so the rule is dormant for new `breakout_retest` and `node_rejection` positions.
- Exit priority is force/expiry handling, confirmation-wick structural invalidation, scheduled close, catastrophic stop, breakeven floor, enabled fixed take-profit, next-node structural target, then the scoped boundary time stop. The control line uses the engineering -15% catastrophic stop and has fixed take-profit disabled.
- The system never holds overnight.
- Nightwatch timeout or HTTP 429 backoff cannot block moomoo position reconciliation, stop handling, or time exits for an existing position.

The retired MULTI rules (historical reference only) live in `config/junk-multi-options-policy.json`:

- The program does not rank or invent a universe. A complete current-session detailed `junkman-analysis` post is the sole source of each ticker and its recommended setup.
- Reference price, Gamma regime, Wall/Flip/Pivot/Magnet levels, explicit trigger, target, invalidation, and scenario weights are copied from that post and retained in the decision audit.
- Closed OpenD five-minute bars only determine whether the published trigger occurred. Missing or ambiguous plan fields remain no-trade; the program does not fill them from another API.
- OpenD verifies that the posted ticker has a real same-day Call and Put chain. After a published trigger, the nearest actual out-of-the-money strike in the matching direction is used because the post specifies the underlying plan rather than an option contract.
- When more than one posted setup confirms in the same completed bar, the matching published scenario weight ranks them. The shared simulated-account lock still permits only one aggregate JUNKMAN entry at a time.

## Three paired exit variants

Pending exit orders do not suspend other variants' stop/breakeven checks. The executor reconciles cumulative fills first, then re-evaluates every remaining variant. A changed exit allocation/priority or lower current sell limit requests cancellation of the existing limit order; its broker-confirmed terminal status and fills are required before a replacement is submitted. Cancellation acknowledgement or timeout alone never frees the quantity for another sell. Strategy thresholds remain unchanged.

Performance reports apply `config/trade-day-validity.json`. The user-voided 2026-09-11 session is excluded from strategy PnL, invested cost/proceeds, win/loss counts, Profit Factor and utilization time; both gains and losses from a voided day are excluded. Raw broker fills, ledger risk accounting and on-chain historical proofs are not rewritten. Reports explicitly label the adjusted scope, and the review export includes this validity registry. `experiment-summary.json.performance` is the adjusted reporting view; its top-level physical/risk fields remain actual unadjusted accounting. Open-position visibility is never suppressed by a reporting exclusion.

One signal, contract, entry time, and fill price create one aggregate position in the moomoo simulated account. Experiment version 4 assigns that position to three local virtual portfolios. Each line has USD 10,000; returns are reported separately, never summed as one strategy's performance. The physical order quantity is three times the per-line quantity after budget and displayed-depth sizing, not a fixed three-contract cap. Only fixed take-profit and catastrophic-stop settings differ:

| line_id | Stop | Fixed take-profit |
| --- | ---: | ---: |
| `control_sl15_tp_off` | -15% | Off |
| `sl10_tp_off` | -10% | Off |
| `sl15_tp30` | -15% | +30% |

All other exit-grid variants and the regime/lifecycle observation line are retired from new entries. Historical cohort definitions and trade records are preserved; old open cohorts must finish under their frozen definitions before a new manifest can enter. The performance page shows the retained three lines, including their valid historical results. The original eight-line configuration remains a test fixture so the September 11 failure is still covered after retirement.

Shared confirmation-wick invalidation, next-node target, breakeven behavior, and close discipline are frozen when a cohort is created. The boundary-only five-minute rule is frozen only when an explicitly supported `range_mean_reversion` cohort exists. An aggregate entry is allocated only after complete equal-unit fills. Any remainder is closed immediately. A broker-to-ledger quantity mismatch stops new actions. A cohort affected by partial exit fills is recorded but excluded from the comparable leaderboard.

## Status and trade records

The SPX line uses the `zero-dte-options` prefix:

- `logs/zero-dte-options-status.json`: heartbeat, mode, provider, and error state.
- `logs/zero-dte-options-runtime-state.json`: positions, orders, recovery, and exit state.
- `logs/zero-dte-options-decisions.ndjson`: strategy gate decisions.
- `logs/zero-dte-options-entry-plans.ndjson`: entry plans and rejection reasons.
- `logs/zero-dte-options-exit-plans.ndjson`: exit plans and trigger reasons.
- `logs/zero-dte-options-trades.ndjson`: simulated orders, fills, exits, and realized results.
- `logs/zero-dte-options-flow-events.ndjson`: automated Flow parsing and eligibility audit.
- `logs/zero-dte-options-experiment-events.ndjson`: per-cohort and per-line events.
- `logs/zero-dte-options-experiment-summary.json`: per-line realized and comparable gross PnL, win rate, and sample count; broker fees are excluded and marked in the file.
- `logs/zero-dte-options-oi-structure-background.json`: compact, non-directional OI research context used in decision audits.
- `data/junk-oi-research/`: ignored local SQLite history and redacted daily source snapshots.

MULTI uses the corresponding `junk-multi-options-*` status, universe, decision, plan, trade, runtime-state, and experiment-summary files. Its source plan log is `logs/junkman-analysis-plans.ndjson`.

Raw runtime data remains local. Before every repository push, generate and include the latest public-safe review snapshot:

```powershell
npm run review:export
git add review-data
```

The dated `review-data/` export contains redacted SPX and JUNKMAN-MULTI decisions, entry/exit plans when present, trades, experiment results, runtime/status snapshots, the MULTI universe, and redacted daily OI source files. Large cumulative decision streams are gzip-compressed. The manifest records source mappings, counts, hashes, and exclusions; an export with invalid lines must be investigated before publishing. Raw `logs/`, browser data, SQLite runtime files, credentials, account identifiers, and Discord identifiers must never be published directly.

Strategy evidence, attributed source material, and engineering boundaries are documented in `docs/junkman-strategy-v3-evidence-2026-08-11.md`.

## Safety and repository boundaries

The repository may contain source code, tests, the JUNKMAN policy, launch scripts, documentation, and a reviewed JUNKMAN trade-record snapshot. Never commit:

- `.env` or any API key, Bearer value, or account secret
- `secrets/` or `profile/`
- unreviewed runtime logs, private Discord content, or account details

See `NEW_DEVICE_SETUP.md` for migration steps.
