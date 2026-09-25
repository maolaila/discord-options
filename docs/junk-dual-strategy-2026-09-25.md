# JUNKMAN dual simulation deployment — 2026-09-25

The baseline keeps its five-minute confirmation and directional Gamma/OI strike selection. `junkman_new_20260925` uses the same closed five-minute signals with an ATM strike rounded to the existing five-point grid, and rejects setups whose next structural target was touched between impulse and confirmation. A spent breakout cannot be relabelled as a same-candle rejection. A fresh body crossing starts a new setup window.

Both policies retain the three frozen exit profiles: SL15 / no fixed TP, SL10 / no fixed TP, and SL15 / TP30. Breakeven, structural exits, pre-close exits and no-overnight rules remain shared. Each strategy has separate runtime state, locks, broker remark prefixes, cohort IDs, logs and reports. Performance is reported per exit line, not as a summed strategy return.

Both use the existing simulation option account and account entry lock. Existing positions or pending orders in the same contract block a second entry. They therefore do not guarantee paired fills between strategies; contract-conflict skips must be included when interpreting comparisons. Orders are still simulation-only and use broker quotes and execution gates.

## Operation

- Baseline: `run-junk-gex.ps1` or `npm run junk:gex:watch-sim`.
- Comparison: `run-junk-new.ps1` or `npm run junk:new:watch-sim`.
- Top-level `run-junk-stack.ps1` starts both supervisors after broker authentication.
- `run-junk-gex.ps1 -AdoptProcessId <pid>` adopts an exactly identified existing simulation watcher without restarting it. Normal restart supervision applies afterwards.
- Read-only preflight: `npm run junk:preflight`, and `node ops/junk-preflight.mjs --strategy=junkman_new_20260925`.
- Console `/api/status` includes separate statuses and readiness. `/api/junk-performance?strategy=junkman_new_20260925` and the matching report query select the new ledger.
- A secondary console can use `CONTROL_CONSOLE_PORT=18767` and `CONTROL_CONSOLE_READ_ONLY=true`; all POST actions are disabled there.

## Release validation and limits

393 automated tests passed, including new entry/exit ownership, identical three-line profiles, ATM selection, consumed-target filtering, and option-chain pagination integrity. Read-only broker verification confirmed authenticated US option simulation and no positions before deployment. No synthetic broker orders were submitted.

The new runner started independently and recovered zero new-strategy orders, while the baseline retained its existing records. A batch restart of pre-existing services was blocked by automatic approval review; the baseline process was preserved and adopted by its supervisor. Consequently, baseline process code remains at the prior version until a controlled restart. The new runner contains the pagination hardening. The updated main stack and port-18766 console also require a later controlled restart to load their new startup/UI logic; the secondary read-only console provides both views now.

Nightwatch returned a temporary chain validation error; a subsequent read successfully merged 652 contracts over three pages. The chain was stale and Dealer GEX returned READ_MODEL_UNAVAILABLE before the open. Those are upstream data readiness blockers; neither running processes nor passing tests prove that a signal or fill will occur. Existing-position reconciliation runs before data-dependent entry evaluation.

One/two-minute signals, direct SPX bars, REST Flow observers and new remaining-space thresholds are deferred; this release does not claim those features.
