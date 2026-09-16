# Nightwatch research integration — 2026-09-17

The active strategy remains the existing simulation-only JUNK SPX 0DTE model and its three exit variants. No entry, sizing, stop, take-profit, breakeven or structural rule changed.

## Provider checks

- Official documentation: [VEX](https://docs.yehangshe.com/heatmap/vex), [Replay Lab](https://docs.yehangshe.com/replay-lab/overview), [options API](https://docs.yehangshe.com/api/domains/options), [public API changelog](https://docs.yehangshe.com/api/changelog).
- Live OpenAPI and authenticated discovery list no public VEX or Tide dataset. VEX stays disabled.
- SPX `/v1/volatility/stats/SPX` and `/v1/volatility/term-structure/SPX` returned HTTP 200 with data date 2026-09-16 and as-of 04:00 UTC. These are daily background values, not intraday IV. Native IV values are preserved without guessing a unit conversion.
- `/v1/market/economic-calendar` returned HTTP 200 and timestamped events, but a null source as-of. The observer preserves this unknown freshness and does not infer calendar completeness or event importance.
- A September 16 Call chain-history request first returned HTTP 202, then `503 READ_MODEL_UNAVAILABLE` with an approximately 15-minute retry interval. This is not a usable historical quote series. The request was not hot-retried.
- The single-contract intraday endpoint can return transaction bars, but transaction OHLC does not supply the historical executable bid/ask path required by the exit planner. It is not substituted for NBBO.

## Read-only behavior

The watcher launches at most one background research request after a successful cycle, never awaiting it before broker reconciliation or exits. The observer runs from 08:00 ET through the session close plus 15 minutes, using the existing holiday and early-close calendar. IV/term refresh every 30 minutes; events every six hours. Failures and materialization misses back off at least five minutes; provider Retry-After can extend the wait. A 429 pauses the entire observer. Research failures do not reset OpenD or change any gate.

Compact context appears in status and is attached to decisions after their gates have been evaluated. A bounded asynchronous writer records the option/underlying inputs already obtained for exit evaluation. It drops observations and exposes its error if storage is unavailable, without delaying exits. Context, quote history and generated reports live under ignored `logs/` paths.

`npm run research:replay -- --date YYYY-MM-DD` produces HTML and JSON with actual complete-fill results for each retained line and US trading day. It honors the existing void-day registry. Offline quote replay invokes the production exit planner with each cohort's frozen exit rules. It assumes immediate execution at bid minus the configured buffer, so its modeled fills must not be confused with broker fills. Missing or stale quotes, gaps over 45 seconds and paths ending before exit produce explicit incomplete results, never zero-filled prices or invented profits.

The September 16 review contains nine comparable completed cohorts per retained line and one unfilled cohort. None has a complete pre-deployment quote journal. Actual results are available; modeled historical results remain unavailable. Each cohort links to the official SPX Replay Lab for manual review. New quote capture begins with this deployment.

## Operation

- `npm run research:snapshot`: read-only provider check; use the existing `YEHANGSHE_API_KEY` environment setup.
- `npm run research:replay -- --date YYYY-MM-DD`: local review; no provider calls or broker execution.
- `/api/status` → `junk_status.research_context`: source dates, freshness, observer state and recorder errors.
- Set `research_context.enabled` to `false` and restart the watcher to disable the observer and recording. Existing trading rules remain independent of that switch.

Validation covers source schema/identity/freshness, unknown calendar age, materialization, blocked requests, 429 retry timing, failed journal writes, quote-path gaps, stop variants, take-profit/breakeven behavior, void days and production integration. The existing trading suite is also required before deployment.

Deployment also reproduced a pre-existing Windows PowerShell 5.1 watchdog failure: BOM-less UTF-8 status JSON containing Chinese text was read with the default ANSI encoding, then rejected as malformed JSON. This caused a healthy watcher to be protected as unreadable and its child supervisor to be removed. Both supervisors now explicitly read UTF-8 for status, policy and health files. A Windows PowerShell regression exercises both watchdogs with Node-written Chinese JSON without a BOM.
