import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultCutoff = '2026-08-14T14:12:08.075Z';

function parseArgs(argv) {
  const options = {
    cutoff: defaultCutoff,
    oldPid: 13736,
    newPid: 23404,
    supervisorPid: 20884,
    output: 'logs/zero-dte-options-post-deploy-summary.json',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--cutoff') options.cutoff = String(value || '').trim();
    else if (arg === '--old-pid') options.oldPid = Number(value);
    else if (arg === '--new-pid') options.newPid = Number(value);
    else if (arg === '--supervisor-pid') options.supervisorPid = Number(value);
    else if (arg === '--output') options.output = String(value || '').trim();
    else throw new Error(`Unknown argument: ${arg}`);
    index += 1;
  }
  if (!Number.isFinite(Date.parse(options.cutoff))) throw new Error('--cutoff must be an ISO timestamp.');
  for (const key of ['oldPid', 'newPid', 'supervisorPid']) {
    if (!Number.isInteger(options[key]) || options[key] <= 0) throw new Error(`--${key} must be a positive integer.`);
  }
  return options;
}

function eventTimestamp(record) {
  for (const key of [
    'generated_at', 'recorded_at', 'created_at', 'updated_at', 'planned_at',
    'submitted_at', 'event_at', 'opened_at', 'closed_at', 'entry_at', 'exit_at',
    'timestamp',
  ]) {
    const value = record?.[key];
    if (Number.isFinite(Date.parse(value))) return value;
  }
  return null;
}

async function scanNdjson(relativePath, cutoffMs, onRecord = () => {}) {
  const absolutePath = path.join(projectRoot, relativePath);
  let totalRecords = 0;
  let invalidLines = 0;
  let recordsAfterCutoff = 0;
  const lines = readline.createInterface({
    input: createReadStream(absolutePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }
    totalRecords += 1;
    const timestamp = eventTimestamp(record);
    if (timestamp && Date.parse(timestamp) >= cutoffMs) {
      recordsAfterCutoff += 1;
      onRecord(record, timestamp);
    }
  }
  return { total_records: totalRecords, invalid_lines: invalidLines, records_after_cutoff: recordsAfterCutoff };
}

async function fileEvidence(relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
  return {
    path: relativePath.replaceAll('\\', '/'),
    bytes: (await stat(absolutePath)).size,
    sha256: hash.digest('hex'),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cutoffMs = Date.parse(options.cutoff);
  const decisionTimes = [];
  const reasonCounts = new Map();
  const snapshotBuckets = new Set();
  let tradeDecisionCount = 0;

  const decisions = await scanNdjson('logs/zero-dte-options-decisions.ndjson', cutoffMs, (record, timestamp) => {
    decisionTimes.push(Date.parse(timestamp));
    if (record.decision === 'trade') tradeDecisionCount += 1;
    if (record.snapshot_at) snapshotBuckets.add(record.snapshot_at);
    for (const reason of Array.isArray(record.reason_codes) ? record.reason_codes : []) {
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
  });
  decisionTimes.sort((left, right) => left - right);
  let maxGapMs = null;
  for (let index = 1; index < decisionTimes.length; index += 1) {
    maxGapMs = Math.max(maxGapMs || 0, decisionTimes[index] - decisionTimes[index - 1]);
  }

  const entryPlans = await scanNdjson('logs/zero-dte-options-entry-plans.ndjson', cutoffMs);
  const exitPlans = await scanNdjson('logs/zero-dte-options-exit-plans.ndjson', cutoffMs);
  const trades = await scanNdjson('logs/zero-dte-options-trades.ndjson', cutoffMs);
  const status = JSON.parse(await readFile(path.join(projectRoot, 'logs/zero-dte-options-status.json'), 'utf8'));
  const runtimeState = JSON.parse(await readFile(path.join(projectRoot, 'logs/zero-dte-options-runtime-state.json'), 'utf8'));
  const simulatedAccount = status.moomoo?.account ?? null;

  const sourcePaths = [
    'logs/zero-dte-options-decisions.ndjson',
    'logs/zero-dte-options-entry-plans.ndjson',
    'logs/zero-dte-options-exit-plans.ndjson',
    'logs/zero-dte-options-trades.ndjson',
    'logs/zero-dte-options-status.json',
    'logs/zero-dte-options-runtime-state.json',
    'logs/zero-dte-options-supervisor.log',
  ];
  const summary = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    business_line: 'zero-dte-options',
    strategy: 'junk_gex_nodes_v3',
    execution_environment: 'simulate_only',
    deployment: {
      cutoff_at: new Date(cutoffMs).toISOString(),
      old_watcher_pid: options.oldPid,
      replacement_watcher_pid: options.newPid,
      supervisor_pid: options.supervisorPid,
      removed_policy_field: 'max_closed_bar_age_ms',
      replacement_age_cutoff_added: false,
    },
    decisions: {
      ...decisions,
      first_at: decisionTimes.length ? new Date(decisionTimes[0]).toISOString() : null,
      last_at: decisionTimes.length ? new Date(decisionTimes.at(-1)).toISOString() : null,
      max_gap_ms: maxGapMs,
      snapshot_bucket_count: snapshotBuckets.size,
      trade_decision_count: tradeDecisionCount,
      reason_counts: Object.fromEntries([...reasonCounts].sort(([left], [right]) => left.localeCompare(right))),
      removed_reason_count: reasonCounts.get('closed_confirmation_bars_stale') || 0,
    },
    post_deploy_artifacts: {
      entry_plans: entryPlans.records_after_cutoff,
      exit_plans: exitPlans.records_after_cutoff,
      trades: trades.records_after_cutoff,
    },
    final_health: {
      status_updated_at: status.updated_at,
      process_id: status.process_id,
      phase: status.phase,
      mode: status.mode,
      real_trading_allowed: status.real_trading_allowed,
      market_open: status.market_schedule?.market_open ?? null,
      entry_open: status.market_schedule?.entry_open ?? null,
      gex_readiness: status.provider?.gex_freshness?.readiness ?? null,
      price_action_ready: status.market_context?.price_action_ready ?? null,
      moomoo_connected: status.moomoo?.connected ?? null,
      simulated_us_options_account_ready: simulatedAccount
        ? simulatedAccount.trd_env === 0 && simulatedAccount.sim_acc_type === 4
        : null,
      broker_recovery: status.broker_recovery?.status ?? null,
      open_position_count: status.risk?.open_position_count ?? null,
      active_order_count: Array.isArray(status.active_orders) ? status.active_orders.length : null,
      runtime_order_count: Array.isArray(runtimeState.orders)
        ? runtimeState.orders.length
        : Object.keys(runtimeState.orders || {}).length,
      last_decision: status.last_decision?.decision ?? null,
      last_reason_codes: status.last_decision?.reason_codes ?? [],
      last_error: status.last_error ?? null,
    },
    sources: await Promise.all(sourcePaths.map(fileEvidence)),
  };

  const outputPath = path.resolve(projectRoot, options.output);
  if (!outputPath.startsWith(`${projectRoot}${path.sep}`)) throw new Error('Output must stay inside the repository.');
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, outputPath);
  process.stdout.write(`${JSON.stringify({ output: path.relative(projectRoot, outputPath), decisions: decisions.records_after_cutoff })}\n`);
}

await main();
