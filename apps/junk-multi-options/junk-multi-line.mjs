import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  KL_TYPE_5MIN,
  QOT_MARKET_US_SECURITY,
  TRD_ENV_SIMULATE,
  cancelOrder,
  connectMoomoo,
  createMoomooQuoteFeed,
  ensureDir,
  fetchMoomooAccounts,
  fetchOrderList,
  fetchPositionList,
  getSecuritySnapshots,
  listOptionContracts,
  loadMoomooConfig,
  normalizeForJson,
  parseCliArgs,
  requestHistoryKL,
  selectSimulatedUsOptionAccount,
} from '../../packages/moomoo-opend/moomoo-opend.mjs';
import {
  businessLineLogPath,
  moomooConfigOptionsForBusinessLine,
  resolveBusinessLine,
} from '../../packages/business-lines/business-lines.mjs';
import { acquireSimulatedOptionsEntryLock } from '../../packages/business-lines/simulated-options-entry-lock.mjs';
import {
  create_nightwatch_rest_client,
  create_snapshot_rate_limiter,
} from '../../packages/nightwatch-api/nightwatch-rest-client.mjs';
import {
  evaluate_junk_gex_strategy,
  normalize_gex_snapshot,
} from '../zero-dte-options/junk-gex-strategy.mjs';
import { apply_junk_v3_evidence } from '../zero-dte-options/junk-trading-model-v2.mjs';
import {
  JUNK_GEX_STRATEGY,
  JUNK_FLOW_HEATMAP_BUSINESS_LINE,
  JUNK_MULTI_BUSINESS_LINE,
  assertZeroDteSimulationOnly,
  executeZeroDteSimulatedEntry,
  prepareZeroDteSimulatedEntry,
} from '../zero-dte-options/zero-dte-moomoo-executor.mjs';
import {
  buildZeroDteSimulatedExitPlan,
  buildZeroDteSimulatedExplicitExitPlan,
  executeZeroDteSimulatedExit,
} from '../zero-dte-options/zero-dte-moomoo-exit.mjs';
import {
  apply_junk_experiment_exit_cumulative_fill,
  begin_junk_experiment_exit_batch,
  build_junk_experiment_cohort,
  create_junk_experiment_ledger,
  exit_config_for_variant,
  experiment_all_variants_flat,
  experiment_total_remaining_qty,
  experiment_unallocated_remaining_qty,
  experiment_variant_remaining_qty,
  finalize_junk_experiment_entry_allocation,
  load_junk_exit_experiment,
  summarize_junk_exit_experiment,
  update_junk_experiment_variant_management,
} from '../zero-dte-options/junk-exit-experiment.mjs';
import {
  broker_order_blocks_new_entry,
  broker_order_identity,
  expired_entry_without_broker_evidence,
  expired_settlement_missing,
  heatmap_summary,
  is_terminal_broker_order,
  settle_expired_option_row_unpriced,
} from '../zero-dte-options/zero-dte-line.mjs';
import {
  inferOptionStrikeStep,
  nightwatchWorkingSetTickers,
  validateNightwatchTickerEvidence,
} from './junk-multi-universe.mjs';
import { buildMultiSymbolMarketContext } from './junk-multi-market-context.mjs';
import {
  JUNKMAN_DAILY_PLAN_STRATEGY,
  evaluateJunkmanDailyPlan,
} from './junkman-daily-plan-strategy.mjs';
import { create_junk_gex_market_context } from '../zero-dte-options/junk-gex-market-context.mjs';
import {
  applyUnusualFlowHeatmapGate,
  readRecentUnusualFlowSeeds,
} from '../junk-flow-heatmap-options/junk-flow-heatmap-source.mjs';

const bootstrapArgs = parseCliArgs(process.argv.slice(2));
const require = createRequire(import.meta.url);
const { readJunkmanAnalysisPlanSource } = require('../../packages/option-signals/junkman-analysis-plan.cjs');
const ACTIVE_BUSINESS_LINE = String(
  process.env.JUNK_ACTIVE_BUSINESS_LINE || bootstrapArgs['business-line'] || JUNK_MULTI_BUSINESS_LINE,
).trim().toLowerCase();
const FLOW_HEATMAP_MODE = ACTIVE_BUSINESS_LINE === JUNK_FLOW_HEATMAP_BUSINESS_LINE;
const ACTIVE_STRATEGY = FLOW_HEATMAP_MODE ? JUNK_GEX_STRATEGY : JUNKMAN_DAILY_PLAN_STRATEGY;
if (![JUNK_MULTI_BUSINESS_LINE, JUNK_FLOW_HEATMAP_BUSINESS_LINE].includes(ACTIVE_BUSINESS_LINE)) {
  throw new Error(`Unsupported multi-symbol JUNKMAN runtime: ${ACTIVE_BUSINESS_LINE}`);
}
const businessLine = resolveBusinessLine(ACTIVE_BUSINESS_LINE);
const statusPath = businessLineLogPath(businessLine, 'status.json');
const statePath = businessLineLogPath(businessLine, 'runtime-state.json');
const decisionsPath = businessLineLogPath(businessLine, 'decisions.ndjson');
const entryPlansPath = businessLineLogPath(businessLine, 'entry-plans.ndjson');
const exitPlansPath = businessLineLogPath(businessLine, 'exit-plans.ndjson');
const tradesPath = businessLineLogPath(businessLine, 'trades.ndjson');
const universePath = businessLineLogPath(businessLine, 'universe.json');
const experimentSummaryPath = businessLineLogPath(businessLine, 'experiment-summary.json');
const runtimeLockPath = businessLineLogPath(businessLine, 'runtime.lock.json');
const sourceFlowEventsPath = path.resolve('logs', 'zero-dte-options-flow-events.ndjson');
const junkmanAnalysisPlansPath = path.resolve('logs', 'junkman-analysis-plans.ndjson');
const sharedSpxStatePath = businessLineLogPath(resolveBusinessLine('zero-dte-options'), 'runtime-state.json');
const POLL_MS = 15_000;
const FIVE_MINUTE_MS = 300_000;

function flag(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function finiteNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveNumber(value, fallback = null) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : fallback;
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
}

export function shouldPollFlowSource({
  universe_present,
  last_poll_at,
  now_ms = Date.now(),
  poll_interval_seconds = 30,
} = {}) {
  if (!universe_present) return true;
  const lastPollMs = Date.parse(String(last_poll_at || ''));
  if (!Number.isFinite(lastPollMs)) return true;
  const intervalMs = Math.max(30_000, finiteNumber(poll_interval_seconds, 30) * 1_000);
  return Number(now_ms) - lastPollMs >= intervalMs;
}

export function shouldRefreshDiscordPlanUniverse({
  entry_open,
  universe,
  session_date_et,
  policy_signature,
  source_signature,
} = {}) {
  if (entry_open !== true) return false;
  return !universe
    || universe.session_date_et !== session_date_et
    || universe.policy_signature !== policy_signature
    || universe.source_signature !== source_signature;
}

function sanitizedError(error) {
  let raw;
  if (error?.message) raw = String(error.message);
  else {
    try { raw = JSON.stringify(normalizeForJson(error)); } catch { raw = String(error || 'unknown error'); }
  }
  return raw
    .replace(/sk_(?:live|test)_[A-Za-z0-9_-]+/g, '[redacted_api_key]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .slice(0, 1_000);
}

function nyContext(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour === '24' ? 0 : values.hour);
  return {
    date_key: `${values.year}-${values.month}-${values.day}`,
    minute_of_day: hour * 60 + Number(values.minute),
    weekday: new Date(`${values.year}-${values.month}-${values.day}T12:00:00Z`).getUTCDay(),
  };
}

function parseMinutes(value, fallback) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? hour * 60 + minute : fallback;
}

function universePolicySignature(policy = {}) {
  const identity = {
    source: String(policy.source || ''),
    channel_id: String(policy.channel_id || ''),
    author_id: String(policy.author_id || ''),
    zero_dte_chain_required: policy.zero_dte_chain_required !== false,
    reserved_underlyings: [...(policy.reserved_underlyings || [])].map(String).sort(),
    option_chain_probe_interval_ms: finiteNumber(policy.option_chain_probe_interval_ms, 3_100),
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16);
}

function marketSchedule(policy, now = new Date()) {
  const ny = nyContext(now);
  const closed = new Set(policy?.market_calendar?.closed_dates_et || []);
  const early = new Set(policy?.market_calendar?.early_close_dates_et || []);
  const weekday = ny.weekday >= 1 && ny.weekday <= 5;
  const marketOpen = weekday && !closed.has(ny.date_key);
  const earlyClose = early.has(ny.date_key);
  const entryStart = parseMinutes(policy?.strategy?.entry_start_time_et, 575);
  const entryCutoff = parseMinutes(policy?.strategy?.entry_cutoff_time_et, 930);
  const sessionClose = earlyClose ? 780 : 960;
  return {
    ...ny,
    market_open: marketOpen,
    early_close: earlyClose,
    entry_open: marketOpen && ny.minute_of_day >= entryStart && ny.minute_of_day < Math.min(entryCutoff, sessionClose),
    session_open: marketOpen && ny.minute_of_day >= 570 && ny.minute_of_day < sessionClose,
  };
}

async function parseJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await fsp.rename(temporary, filePath);
  await fsp.copyFile(filePath, `${filePath}.bak`);
}

async function appendJsonLine(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fsp.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function processRunning(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function acquireRuntimeLock() {
  await ensureDir(path.dirname(runtimeLockPath));
  const existing = await parseJson(runtimeLockPath);
  if (existing?.process_id && processRunning(existing.process_id)) {
    throw new Error(`${ACTIVE_BUSINESS_LINE} is already running with pid=${existing.process_id}.`);
  }
  await fsp.unlink(runtimeLockPath).catch(() => {});
  const token = randomUUID();
  await fsp.writeFile(runtimeLockPath, `${JSON.stringify({
    process_id: process.pid,
    token,
    acquired_at: new Date().toISOString(),
  })}\n`, { encoding: 'utf8', flag: 'wx' });
  return async () => {
    const current = await parseJson(runtimeLockPath);
    if (current?.token === token && Number(current?.process_id) === process.pid) {
      await fsp.unlink(runtimeLockPath).catch(() => {});
    }
  };
}

function defaultState() {
  return {
    schema_version: 1,
    business_line: ACTIVE_BUSINESS_LINE,
    strategy: ACTIVE_STRATEGY,
    session_date_et: null,
    universe: null,
    last_flow_source_poll_at: null,
    gex_history_by_ticker: {},
    last_scanned_bucket_by_ticker: {},
    executed_signal_ids: [],
    orders: {},
    last_error: null,
    updated_at: null,
  };
}

function normalizeState(value) {
  const base = defaultState();
  if (!value || value.business_line !== ACTIVE_BUSINESS_LINE) return base;
  return {
    ...base,
    ...value,
    strategy: ACTIVE_STRATEGY,
    gex_history_by_ticker: value.gex_history_by_ticker || {},
    last_scanned_bucket_by_ticker: value.last_scanned_bucket_by_ticker || {},
    executed_signal_ids: Array.isArray(value.executed_signal_ids) ? value.executed_signal_ids : [],
    orders: value.orders || {},
  };
}

function brokerRows(response, listName) {
  const rows = normalizeForJson(response)?.s2c?.[listName];
  return Array.isArray(rows) ? rows : [];
}

function orderIdentityKeys(value) {
  const identity = broker_order_identity(value);
  return [identity.order_id_ex ? `ex:${identity.order_id_ex}` : null, identity.order_id ? `id:${identity.order_id}` : null]
    .filter(Boolean);
}

function findBrokerOrder(orders, row, prefix) {
  const keys = new Set(orderIdentityKeys({
    order_id: row?.[`${prefix}_order_id`],
    order_id_ex: row?.[`${prefix}_order_id_ex`],
  }));
  const byIdentity = orders.find((order) => orderIdentityKeys(order).some((key) => keys.has(key)));
  if (byIdentity) return byIdentity;
  const expectedRemark = String(row?.[`${prefix}_remark`] || '').trim();
  return expectedRemark
    ? (orders.find((order) => String(order?.remark || '') === expectedRemark) || null)
    : null;
}

function brokerFill(order) {
  const qty = Math.max(0, Math.floor(finiteNumber(order?.fillQty, 0)));
  const avgPrice = positiveNumber(order?.fillAvgPrice);
  return { qty, avg_price: avgPrice };
}

function positionCost(position) {
  return positiveNumber(
    position?.averageCostPrice ?? position?.dilutedCostPrice ?? position?.costPrice,
  );
}

function terminalLocalRow(row) {
  return [
    'closed',
    'entry_unfilled_terminal',
    'expired_no_submission_evidence',
    'expired_settled_unpriced',
  ].includes(String(row?.status || ''));
}

function activeRows(state) {
  return Object.values(state.orders || {}).filter((row) => !terminalLocalRow(row));
}

async function activeOtherJunkRows() {
  const lineIds = ['zero-dte-options', JUNK_MULTI_BUSINESS_LINE, JUNK_FLOW_HEATMAP_BUSINESS_LINE]
    .filter((lineId) => lineId !== ACTIVE_BUSINESS_LINE);
  const rows = [];
  for (const lineId of lineIds) {
    const line = resolveBusinessLine(lineId);
    const state = await parseJson(businessLineLogPath(line, 'runtime-state.json'));
    for (const row of Object.values(state?.orders || {})) {
      if (terminalLocalRow(row)) continue;
      rows.push({ business_line: lineId, ...row });
    }
  }
  return rows;
}

function compactRow(row) {
  return {
    plan_id: row.plan_id,
    ticker: row.ticker,
    code: row.code,
    status: row.status,
    filled_qty: row.filled_qty || 0,
    remaining_qty: row.experiment_ledger ? experiment_total_remaining_qty(row.experiment_ledger) : 0,
    entry_fill_price: row.entry_fill_price || null,
    pending_exit: Boolean(row.experiment_ledger?.pending_exit_batch),
  };
}

function configureForFinalists(baseConfig, finalists) {
  return {
    ...baseConfig,
    businessLine: ACTIVE_BUSINESS_LINE,
    trdEnv: TRD_ENV_SIMULATE,
    allowRealTrading: false,
    policyExecutionEnvironment: 'simulate_only',
    policyRealTradingAllowed: false,
    policy: {
      ...baseConfig.policy,
      risk_limits: {
        ...(baseConfig.policy?.risk_limits || {}),
        allowed_underlyings: finalists.map((row) => row.ticker),
      },
    },
  };
}

async function refreshDailyPlanUniverse({ client, config, sessionDateEt, source, previousUniverse = null }) {
  const universePolicy = config.policy?.universe || {};
  const cachedFinalists = new Map(
    (previousUniverse?.session_date_et === sessionDateEt ? previousUniverse?.finalists : [])
      .filter((row) => row?.zero_dte_chain_verified === true && row?.plan?.event_id)
      .map((row) => [`${row.ticker}:${row.plan.event_id}`, row]),
  );
  const finalists = [];
  const probeErrors = [];
  const optionChainProbeIntervalMs = Math.max(
    3_000,
    finiteNumber(universePolicy.option_chain_probe_interval_ms, 3_100),
  );
  let previousProbeAt = null;
  let optionChainProbeCount = 0;
  for (const plan of source?.seeds || []) {
    const cached = cachedFinalists.get(`${plan.ticker}:${plan.event_id}`);
    if (cached) {
      finalists.push({ ...cached, plan, option_chain_cache_hit: true });
      continue;
    }
    try {
      if (previousProbeAt !== null) {
        await sleep(Math.max(0, optionChainProbeIntervalMs - (Date.now() - previousProbeAt)));
      }
      previousProbeAt = Date.now();
      optionChainProbeCount += 1;
      const chain = await listOptionContracts(client, { ticker: plan.ticker, expiration: sessionDateEt });
      const strikeStep = inferOptionStrikeStep(chain.contracts);
      const calls = chain.contracts.filter((row) => row.optionRight === 'C');
      const puts = chain.contracts.filter((row) => row.optionRight === 'P');
      const callCount = calls.length;
      const putCount = puts.length;
      if (callCount > 0 && putCount > 0 && strikeStep !== null) {
        finalists.push({
          ticker: plan.ticker,
          plan,
          expiration: sessionDateEt,
          option_contract_count: chain.contracts.length,
          call_contract_count: callCount,
          put_contract_count: putCount,
          option_strike_step_points: strikeStep,
          option_strikes_by_right: {
            C: [...new Set(calls.map((row) => positiveNumber(row.strikePrice)).filter(Boolean))].sort((a, b) => a - b),
            P: [...new Set(puts.map((row) => positiveNumber(row.strikePrice)).filter(Boolean))].sort((a, b) => a - b),
          },
          plan_message_id: plan.message_id,
          plan_strategy_kind: plan.execution.kind,
          plan_strategy_title: plan.strategy_title,
          plan_source: plan.source,
          zero_dte_chain_verified: true,
          option_chain_cache_hit: false,
        });
      }
    } catch (error) {
      probeErrors.push({ ticker: plan.ticker, error: sanitizedError(error) });
    }
  }
  return {
    refreshed_at: new Date().toISOString(),
    session_date_et: sessionDateEt,
    source: 'discord_junkman_analysis_daily_plan',
    source_status: source?.source_status || 'unknown',
    source_signature: source?.source_signature || 'missing',
    published_plan_count: source?.seeds?.length || 0,
    rejected_plan_count: source?.rejected?.length || 0,
    intersected_candidate_count: source?.seeds?.length || 0,
    probed_candidate_count: optionChainProbeCount,
    option_chain_cache_hit_count: finalists.filter((row) => row.option_chain_cache_hit).length,
    policy_signature: universePolicySignature(universePolicy),
    option_chain_probe_interval_ms: optionChainProbeIntervalMs,
    finalists,
    probe_errors: probeErrors,
  };
}

async function refreshFlowHeatmapUniverse({
  client,
  nightwatch,
  config,
  sessionDateEt,
  source,
  previousUniverse = null,
}) {
  const universePolicy = config.policy?.universe || {};
  const cachedFinalists = new Map(
    (previousUniverse?.session_date_et === sessionDateEt ? previousUniverse?.finalists : [])
      .filter((row) => row?.nightwatch_supported === true && row?.zero_dte_chain_verified === true)
      .map((row) => [String(row.ticker || '').toUpperCase(), row]),
  );
  const needsCoverageRefresh = (source?.seeds || []).some((seed) => !cachedFinalists.has(seed.ticker));
  let coverage = new Set(cachedFinalists.keys());
  let coverageCount = finiteNumber(previousUniverse?.nightwatch_working_set_count, coverage.size);
  if (needsCoverageRefresh) {
    const discoverResponse = await nightwatch.discover_datasets();
    coverage = nightwatchWorkingSetTickers(
      discoverResponse,
      String(universePolicy.nightwatch_working_set || 'dealer-heatmap'),
    );
    coverageCount = coverage.size;
  }
  const finalists = [];
  const probeErrors = [];
  const candidates = (source?.seeds || []).filter((seed) => coverage.has(seed.ticker));
  const probeIntervalMs = Math.max(
    3_000,
    finiteNumber(universePolicy.option_chain_probe_interval_ms, 3_100),
  );
  let previousProbeAt = null;
  let optionChainProbeCount = 0;
  for (const seed of candidates) {
    const cached = cachedFinalists.get(seed.ticker);
    if (cached) {
      finalists.push({
        ...cached,
        ...seed,
        expiration: sessionDateEt,
        nightwatch_supported: true,
        zero_dte_chain_verified: true,
        option_chain_cache_hit: true,
      });
      continue;
    }
    try {
      if (previousProbeAt !== null) {
        await sleep(Math.max(0, probeIntervalMs - (Date.now() - previousProbeAt)));
      }
      previousProbeAt = Date.now();
      optionChainProbeCount += 1;
      const chain = await listOptionContracts(client, { ticker: seed.ticker, expiration: sessionDateEt });
      const strikeStep = inferOptionStrikeStep(chain.contracts);
      const callCount = chain.contracts.filter((row) => row.optionRight === 'C').length;
      const putCount = chain.contracts.filter((row) => row.optionRight === 'P').length;
      if (callCount < 1 || putCount < 1 || strikeStep === null) continue;
      finalists.push({
        ...seed,
        expiration: sessionDateEt,
        option_contract_count: chain.contracts.length,
        call_contract_count: callCount,
        put_contract_count: putCount,
        option_strike_step_points: strikeStep,
        nightwatch_gate: 'dealer-heatmap-working-set',
        nightwatch_supported: true,
        zero_dte_chain_verified: true,
        option_chain_cache_hit: false,
      });
    } catch (error) {
      probeErrors.push({ ticker: seed.ticker, error: sanitizedError(error) });
    }
  }
  return {
    refreshed_at: new Date().toISOString(),
    session_date_et: sessionDateEt,
    source: 'discord_nightwatch_0dte_flow_alert_plus_nightwatch_heatmap',
    source_status: source?.source_status || 'unknown',
    source_error: source?.source_error || null,
    source_signature: source?.source_signature || 'missing',
    source_tail_diagnostics: source?.tail_diagnostics || null,
    observed_event_count: source?.observed_event_count || 0,
    recent_live_event_count: source?.accepted?.length || 0,
    rejected_event_count: source?.rejected?.length || 0,
    nightwatch_working_set_count: coverageCount,
    intersected_candidate_count: candidates.length,
    probed_candidate_count: optionChainProbeCount,
    option_chain_cache_hit_count: finalists.filter((row) => row.option_chain_cache_hit === true).length,
    option_chain_probe_interval_ms: probeIntervalMs,
    finalists,
    probe_errors: probeErrors,
  };
}

export function moomooUnderlyingCode(ticker) {
  return String(ticker || '').trim().toUpperCase() === 'SPX'
    ? '.SPX'
    : String(ticker || '').trim().toUpperCase();
}

async function sharedSpxMarketContext(client, nowMs) {
  const state = await parseJson(sharedSpxStatePath);
  if (!state?.market_context) throw new Error('shared_spx_market_context_missing');
  const builder = create_junk_gex_market_context({
    ...state.market_context,
    // The SPX owner persists its live SPY feed on a heartbeat. A bounded
    // allowance keeps complete 5-minute bars reusable without weakening the
    // final current-price check, which is refreshed from OpenD below.
    max_latest_spy_quote_age_ms: 20_000,
    now_ms: () => Number(nowMs),
  });
  const context = builder.build_market_context({ at_ms: Number(nowMs) });
  const snapshot = await getSecuritySnapshots(client, [{
    market: QOT_MARKET_US_SECURITY,
    code: 'SPY',
  }]);
  const currentSpyPrice = positiveNumber(snapshot?.s2c?.snapshotList?.[0]?.basic?.curPrice);
  const mappedCurrentPrice = currentSpyPrice !== null && positiveNumber(context.spy_to_spx_scale_ratio) !== null
    ? currentSpyPrice * context.spy_to_spx_scale_ratio
    : null;
  const latest = context.bars_5m?.at(-1) || null;
  return {
    ...context,
    last_price_usd: mappedCurrentPrice === null ? context.last_price_usd : mappedCurrentPrice,
    current_price_source: mappedCurrentPrice === null
      ? 'shared_spx_owner_state'
      : 'moomoo_spy_snapshot_mapped_to_spx',
    current_spy_snapshot_price_usd: currentSpyPrice,
    expected_bucket_at: latest?.timestamp || null,
    latest_closed_bar_at: latest?.timestamp || null,
  };
}

async function ownSymbolMarketContext(client, ticker, sessionDateEt, nowMs) {
  if (FLOW_HEATMAP_MODE && String(ticker || '').toUpperCase() === 'SPX') {
    return sharedSpxMarketContext(client, nowMs);
  }
  const response = await requestHistoryKL(client, {
    market: QOT_MARKET_US_SECURITY,
    code: moomooUnderlyingCode(ticker),
  }, {
    klType: KL_TYPE_5MIN,
    beginTime: `${sessionDateEt} 09:30:00`,
    endTime: `${sessionDateEt} 16:00:00`,
    maxAckKLNum: 100,
  });
  return buildMultiSymbolMarketContext(response, { session_date_et: sessionDateEt, now_ms: nowMs });
}

function strategyPolicy(config, finalist) {
  const step = positiveNumber(finalist?.option_strike_step_points);
  return {
    ...(config.policy?.strategy || {}),
    execution_environment: 'simulate_only',
    real_trading_allowed: false,
    option_strike_step_points: step,
    option_strike_offset_points: step,
  };
}

function hardNightwatchGate(decision, evidence) {
  const reasons = [];
  if (!evidence.passed) reasons.push(...evidence.reasons.map((reason) => `nightwatch_ticker_evidence:${reason}`));
  if (reasons.length === 0) return decision;
  return {
    ...decision,
    decision: 'no_trade',
    action: 'hold',
    reason_codes: [...new Set([...(decision?.reason_codes || []), ...reasons])],
  };
}

async function evaluateTicker({ nightwatch, config, finalist, marketContext, history, nowMs }) {
  const ticker = finalist.ticker;
  if (!FLOW_HEATMAP_MODE) {
    const decision = evaluateJunkmanDailyPlan({
      plan: finalist.plan,
      market_context: marketContext,
      strikes_by_right: finalist.option_strikes_by_right,
      expiration: finalist.expiration,
      now_ms: nowMs,
    });
    return {
      decision: {
        ...decision,
        business_line: ACTIVE_BUSINESS_LINE,
        generated_at: new Date(nowMs).toISOString(),
        expiration: finalist.expiration,
        universe_provenance: {
          source: 'discord_junkman_analysis_daily_plan',
          source_plan_message_id: finalist.plan?.message_id || null,
          source_plan_event_id: finalist.plan?.event_id || null,
          source_plan_session_date_et: finalist.plan?.session_date_et || null,
          source_plan_strategy_title: finalist.plan?.strategy_title || null,
          same_day_zero_dte_chain_verified: true,
          option_strike_step_points: finalist.option_strike_step_points,
        },
      },
      history: history || [],
    };
  }
  const expectedBucketAt = marketContext.expected_bucket_at;
  const gexResponse = await nightwatch.get_dealer_gex_snapshot(ticker);
  let heatmapResponse = null;
  let heatmapFetchError = null;
  try {
    heatmapResponse = await nightwatch.get_heatmap_snapshot(ticker);
  } catch (error) {
    heatmapFetchError = sanitizedError(error);
  }
  const heatmapContext = heatmap_summary(heatmapResponse, {
    now_ms: nowMs,
    max_age_ms: config.policy?.strategy?.max_snapshot_age_ms,
  });
  const evidenceBase = validateNightwatchTickerEvidence({
    ticker,
    session_date_et: finalist.expiration,
    expected_bucket_at: expectedBucketAt,
    gex_response: gexResponse,
    // The current Heatmap schema does not expose a raw `data.state` field.
    // Use the normalized context so freshness is evaluated from generated_at
    // plus the response metadata instead of being misclassified as missing.
    heatmap_response: heatmapContext,
    now_ms: nowMs,
    max_age_ms: config.policy?.strategy?.max_snapshot_age_ms,
    require_heatmap_snapshot: config.policy?.strategy?.require_heatmap_snapshot === true,
  });
  const evidence = {
    ...evidenceBase,
    advisory_reasons: [...new Set([
      ...(evidenceBase.advisory_reasons || []),
      ...(heatmapFetchError ? [`heatmap_request_failed_neutral:${heatmapFetchError}`] : []),
    ])],
  };
  const currentHistory = [...(history || []), normalize_gex_snapshot(gexResponse)]
    .filter((row) => row.snapshot_at && row.session_date_et === finalist.expiration)
    .slice(-12);
  const input = {
    gex_snapshot: gexResponse,
    gex_node_history: currentHistory,
    market_context: marketContext,
    policy: strategyPolicy(config, finalist),
    now_ms: nowMs,
  };
  let core = evaluate_junk_gex_strategy(input);
  const needsChain = (core.reason_codes || []).some((reason) => /^missing_(call|put)_directional_gex_reference$/.test(reason));
  if (needsChain && evidence.passed) {
    const chainResponse = await nightwatch.get_options_chain_snapshot(ticker, {
      query: { expiration: finalist.expiration },
    });
    core = evaluate_junk_gex_strategy({ ...input, option_chain_snapshot: chainResponse });
  }
  let decision = apply_junk_v3_evidence({
    core_decision: core,
    heatmap_context: heatmapContext,
    flow_evaluation: {
      decision: 'neutral',
      availability_status: 'not_used',
      reason_codes: ['junk_multi_flow_dependency_none'],
    },
    evidence_policy: config.policy?.evidence_gates || {},
    now_ms: nowMs,
  });
  decision = hardNightwatchGate(decision, evidence);
  if (FLOW_HEATMAP_MODE) {
    decision = applyUnusualFlowHeatmapGate(decision, finalist, {
      now_ms: nowMs,
      max_event_age_ms: Math.max(
        30_000,
        finiteNumber(config.policy?.strategy?.flow_event_max_age_seconds, 300) * 1_000,
      ),
    });
  }
  return {
    decision: {
      ...decision,
      business_line: ACTIVE_BUSINESS_LINE,
      strategy: JUNK_GEX_STRATEGY,
      generated_at: new Date(nowMs).toISOString(),
      expiration: finalist.expiration,
      market_context: {
        ...marketContext,
        bars_5m: marketContext.bars_5m.slice(-20),
      },
      universe_provenance: {
        source: 'nightwatch_unusual_flow',
        flow_event_id: finalist.flow_event_id || null,
        flow_message_id: finalist.flow_message_id || null,
        flow_direction: finalist.flow_direction || null,
        flow_strike_usd: finalist.flow_strike_usd || null,
        nightwatch_supported: true,
        same_day_zero_dte_chain_verified: true,
        option_strike_step_points: finalist.option_strike_step_points,
      },
      nightwatch_ticker_evidence: evidence,
    },
    history: currentHistory,
  };
}

function rankTradeDecisions(left, right) {
  if (left?.strategy === JUNKMAN_DAILY_PLAN_STRATEGY || right?.strategy === JUNKMAN_DAILY_PLAN_STRATEGY) {
    return finiteNumber(right?.source_plan_weight_pct, 0) - finiteNumber(left?.source_plan_weight_pct, 0)
      || Date.parse(left?.source_daily_plan?.message_timestamp || 0) - Date.parse(right?.source_daily_plan?.message_timestamp || 0)
      || String(left?.ticker || '').localeCompare(String(right?.ticker || ''));
  }
  return finiteNumber(left?.tested_node?.rank, 999) - finiteNumber(right?.tested_node?.rank, 999)
    || Math.abs(finiteNumber(right?.tested_node?.net_gex_usd, 0)) - Math.abs(finiteNumber(left?.tested_node?.net_gex_usd, 0));
}

function accountExposure(positions, orders, currentSessionDate = nyContext(new Date()).date_key) {
  const openPositions = positions.filter((row) => finiteNumber(row?.qty, 0) > 0);
  const pendingOrders = orders.filter((row) => broker_order_blocks_new_entry(row, currentSessionDate));
  return {
    clear: openPositions.length === 0 && pendingOrders.length === 0,
    open_position_count: openPositions.length,
    pending_order_count: pendingOrders.length,
  };
}

export function scopedEntryExposure(
  positions,
  orders,
  contractCode,
  currentSessionDate = nyContext(new Date()).date_key,
) {
  const code = String(contractCode || '');
  const sameContractPositions = positions.filter((row) => (
    String(row?.code || '') === code && finiteNumber(row?.qty, 0) > 0
  ));
  const sameContractOrders = orders.filter((row) => (
    String(row?.code || '') === code && broker_order_blocks_new_entry(row, currentSessionDate)
  ));
  return {
    clear: sameContractPositions.length === 0 && sameContractOrders.length === 0,
    same_contract_position_count: sameContractPositions.length,
    same_contract_pending_order_count: sameContractOrders.length,
  };
}

function entryRowFromExecution(plan, execution, now) {
  const identity = broker_order_identity(execution?.execution || {});
  return {
    plan_id: plan.plan_id,
    signal_id: plan.signal.signal_id,
    ticker: plan.signal.ticker,
    code: plan.order.code,
    expiration: plan.contract.expiration,
    direction: plan.signal.direction,
    setup_type: plan.signal.node_reaction,
    invalidation_price: plan.signal.invalidation_price,
    target_price: plan.signal.target_price,
    contract_multiplier: finiteNumber(plan.position_sizing?.contract_multiplier, 100),
    submitted_qty: plan.order.qty,
    filled_qty: 0,
    exited_qty: 0,
    entry_limit_price: plan.order.price,
    entry_fill_price: null,
    entry_order_id: identity.order_id,
    entry_order_id_ex: identity.order_id_ex,
    entry_remark: plan.order.remark,
    entry_submitted_at: execution?.execution?.submitted_at || now.toISOString(),
    status: execution?.execution?.submitted ? 'entry_submitted' : 'entry_unfilled_terminal',
    experiment_ledger: create_junk_experiment_ledger(plan.experiment, now),
    exit_attempt_no: 0,
    updated_at: now.toISOString(),
  };
}

function variantOwnedPosition(row, variant) {
  return {
    business_line: ACTIVE_BUSINESS_LINE,
    strategy: ACTIVE_STRATEGY,
    plan_id: row.plan_id,
    code: row.code,
    expiration: row.expiration,
    filled_qty: variant.allocated_entry_qty,
    exited_qty: variant.allocated_exit_qty,
    pending_exit_qty: variant.pending_exit_qty,
    entry_fill_price: row.entry_fill_price,
    direction: row.direction,
    invalidation_price: row.invalidation_price,
    target_price: row.target_price,
    setup_type: row.setup_type,
    entry_filled_at: row.entry_filled_at,
    peak_option_return_pct: variant.peak_option_return_pct,
    breakeven_armed: variant.breakeven_armed,
    partial_target_taken: variant.partial_target_taken,
    management_floor_pct: variant.management_floor_pct,
    position_id: row.position_id || null,
  };
}

function aggregateOwnedPosition(row) {
  return {
    business_line: ACTIVE_BUSINESS_LINE,
    strategy: ACTIVE_STRATEGY,
    plan_id: row.plan_id,
    experiment_id: row.experiment_ledger.experiment_id,
    cohort_id: row.experiment_ledger.cohort_id,
    experiment_line_ids: Object.keys(row.experiment_ledger.variants || {}),
    code: row.code,
    expiration: row.expiration,
    filled_qty: row.filled_qty,
    exited_qty: row.exited_qty,
    pending_exit_qty: 0,
    entry_fill_price: row.entry_fill_price,
    direction: row.direction,
    invalidation_price: row.invalidation_price,
    target_price: row.target_price,
    position_id: row.position_id || null,
  };
}

async function optionSnapshot(quoteFeed, row) {
  const security = { market: QOT_MARKET_US_SECURITY, code: row.code };
  const result = await quoteFeed.getSnapshots([security], { orderBookSecurities: [security] });
  return result?.snapshots?.find((item) => item?.basic?.security?.code === row.code)
    || result?.snapshots?.[0]
    || null;
}

async function currentUnderlyingPrice(client, ticker) {
  if (FLOW_HEATMAP_MODE && String(ticker || '').toUpperCase() === 'SPX') {
    return positiveNumber((await sharedSpxMarketContext(client, Date.now())).last_price_usd);
  }
  const response = await getSecuritySnapshots(client, [{
    market: QOT_MARKET_US_SECURITY,
    code: moomooUnderlyingCode(ticker),
  }]);
  return positiveNumber(response?.s2c?.snapshotList?.[0]?.basic?.curPrice);
}

async function reconcileRows({ client, config, quoteFeed, state, now, persist }) {
  const [orderResponse, positionResponse] = await Promise.all([
    fetchOrderList(client, config),
    fetchPositionList(client, config),
  ]);
  const orders = brokerRows(orderResponse, 'orderList');
  const positions = brokerRows(positionResponse, 'positionList');
  const currentSessionDate = nyContext(now).date_key;
  for (const row of activeRows(state)) {
    const position = positions.find((candidate) => String(candidate?.code || '') === row.code) || null;
    if (position) {
      row.position_id = position.positionID ?? position.positionId ?? row.position_id ?? null;
      row.broker_position_qty = finiteNumber(position.qty, 0);
      row.broker_can_sell_qty = finiteNumber(position.canSellQty, 0);
    }
    const entryOrder = findBrokerOrder(orders, row, 'entry');
    if (!entryOrder
      && expired_entry_without_broker_evidence(row, position, currentSessionDate)) {
      row.status = 'expired_no_submission_evidence';
      row.pending_exit_qty = 0;
      row.last_error = 'expired_entry_has_no_broker_order_fill_or_position_evidence';
      row.updated_at = now.toISOString();
      continue;
    }
    if (!entryOrder && ['entry_intent', 'entry_submission_unknown', 'entry_submitted'].includes(row.status)) {
      row.status = 'recovery_blocked';
      row.last_error = 'owned_entry_order_not_found_fail_closed';
      continue;
    }
    if (entryOrder && !row.experiment_ledger.entry_allocation_finalized) {
      const fill = brokerFill(entryOrder);
      row.filled_qty = Math.max(row.filled_qty || 0, fill.qty);
      if (fill.avg_price !== null) row.entry_fill_price = fill.avg_price;
      const entryAgeMs = now.getTime() - Date.parse(row.entry_submitted_at || '');
      if (!is_terminal_broker_order(entryOrder.orderStatus)
        && Number.isFinite(entryAgeMs)
        && entryAgeMs >= finiteNumber(config.policy?.risk_limits?.entry_order_ttl_seconds, 45) * 1_000) {
        const identity = broker_order_identity(entryOrder);
        await cancelOrder(client, config, { orderID: identity.order_id, orderIDEx: identity.order_id_ex });
        row.status = 'entry_cancel_requested';
      }
      if (is_terminal_broker_order(entryOrder.orderStatus)) {
        if (fill.qty < 1) {
          row.status = 'entry_unfilled_terminal';
        } else if (fill.avg_price === null) {
          row.status = 'recovery_blocked';
          row.last_error = 'positive_entry_fill_missing_average_price';
        } else {
          row.entry_fill_price = fill.avg_price;
          row.entry_filled_at = entryOrder.updatedTime || entryOrder.createTime || now.toISOString();
          row.experiment_ledger = finalize_junk_experiment_entry_allocation(row.experiment_ledger, {
            filled_qty: fill.qty,
            fill_avg_price: fill.avg_price,
            now,
          });
          row.status = 'open';
        }
      }
    }

    if (row.experiment_ledger.pending_exit_batch) {
      const exitOrder = findBrokerOrder(orders, row, 'exit');
      if (!exitOrder) {
        if (expired_settlement_missing(row, position, currentSessionDate)) {
          settle_expired_option_row_unpriced(row, { now, broker_position: position });
          continue;
        }
        row.status = 'recovery_blocked';
        row.last_error = 'owned_exit_order_not_found_fail_closed';
        continue;
      }
      const fill = brokerFill(exitOrder);
      if (fill.qty > 0 && fill.avg_price === null) {
        row.status = 'recovery_blocked';
        row.last_error = 'positive_exit_fill_missing_average_price';
        continue;
      }
      const applied = apply_junk_experiment_exit_cumulative_fill(row.experiment_ledger, {
        cumulative_fill_qty: fill.qty,
        cumulative_fill_avg_price: fill.avg_price,
        terminal: is_terminal_broker_order(exitOrder.orderStatus),
        now,
      });
      row.experiment_ledger = applied.ledger;
      row.exited_qty = Math.max(0, row.filled_qty - experiment_total_remaining_qty(row.experiment_ledger));
      if (is_terminal_broker_order(exitOrder.orderStatus)) {
        row.exit_order_id = null;
        row.exit_order_id_ex = null;
        row.exit_remark = null;
        row.status = experiment_all_variants_flat(row.experiment_ledger) ? 'closed' : 'open';
      } else {
        row.status = 'exit_submitted';
      }
    }

    if (expired_settlement_missing(row, position, currentSessionDate)) {
      settle_expired_option_row_unpriced(row, { now, broker_position: position });
      continue;
    }

    if (row.status === 'open' && row.experiment_ledger.entry_allocation_finalized && !row.experiment_ledger.pending_exit_batch) {
      const snapshot = await optionSnapshot(quoteFeed, row);
      const underlyingPrice = await currentUnderlyingPrice(client, row.ticker);
      const allocations = {};
      const reasonByLine = {};
      let marketExit = false;
      const unallocated = experiment_unallocated_remaining_qty(row.experiment_ledger);
      if (unallocated > 0) {
        allocations.__unallocated__ = unallocated;
        reasonByLine.__unallocated__ = 'experiment_unallocated_entry_remainder';
      }
      for (const [lineId, variant] of Object.entries(row.experiment_ledger.variants || {})) {
        if (experiment_variant_remaining_qty(variant) < 1) continue;
        const variantConfig = exit_config_for_variant(config, variant);
        const plan = buildZeroDteSimulatedExitPlan({
          owned_position: variantOwnedPosition(row, variant),
          option_snapshot: snapshot,
          underlying_price_usd: underlyingPrice,
          config: variantConfig,
          now,
        });
        row.experiment_ledger = update_junk_experiment_variant_management(
          row.experiment_ledger,
          lineId,
          plan.management_update,
        );
        if (plan.gate.passed && plan.order?.qty > 0) {
          allocations[lineId] = plan.order.qty;
          reasonByLine[lineId] = plan.trigger?.reason || 'variant_exit_trigger';
          if (plan.order.order_type === 'market') marketExit = true;
        }
      }
      const requestedQty = Object.values(allocations).reduce((sum, qty) => sum + Number(qty || 0), 0);
      if (requestedQty > 0) {
        const attemptNo = Number(row.exit_attempt_no || 0) + 1;
        const remarkPrefix = FLOW_HEATMAP_MODE ? 'junk_flow_hm_exit' : 'junk_multi_exit';
        const remark = `${remarkPrefix}:${String(row.plan_id).slice(-20)}:${attemptNo}`.slice(0, 60);
        row.experiment_ledger = begin_junk_experiment_exit_batch(row.experiment_ledger, {
          allocations,
          reason_by_line: reasonByLine,
          attempt_no: attemptNo,
          remark,
          now,
        });
        const exitPlan = buildZeroDteSimulatedExplicitExitPlan({
          owned_position: aggregateOwnedPosition(row),
          option_snapshot: snapshot,
          requested_exit_qty: requestedQty,
          reason: Object.values(reasonByLine).join('|').slice(0, 200),
          trigger_type: FLOW_HEATMAP_MODE ? 'junk_flow_heatmap_experiment_batch' : 'junk_multi_experiment_batch',
          order_type: marketExit ? 'market' : 'limit',
          config,
          now,
        });
        if (exitPlan.order) exitPlan.order.remark = remark;
        await appendJsonLine(exitPlansPath, exitPlan);
        if (!exitPlan.gate.passed) {
          row.experiment_ledger.pending_exit_batch = null;
          for (const variant of Object.values(row.experiment_ledger.variants || {})) variant.pending_exit_qty = 0;
          row.last_error = `exit_plan_gate_failed:${exitPlan.gate.reasons.join(',')}`;
        } else {
          row.exit_attempt_no = attemptNo;
          row.exit_remark = remark;
          row.status = 'exit_intent';
          await persist();
          const execution = await executeZeroDteSimulatedExit({ client, config, plan: exitPlan, now });
          await appendJsonLine(exitPlansPath, execution);
          const identity = broker_order_identity(execution.execution || {});
          row.exit_order_id = identity.order_id;
          row.exit_order_id_ex = identity.order_id_ex;
          row.exit_remark = remark;
          row.status = execution.execution?.submitted ? 'exit_submitted' : 'open';
          if (!execution.execution?.submitted) {
            row.experiment_ledger.pending_exit_batch = null;
            for (const variant of Object.values(row.experiment_ledger.variants || {})) variant.pending_exit_qty = 0;
          }
          await appendJsonLine(tradesPath, {
            event: 'exit_order_submitted',
            at: now.toISOString(),
            plan_id: row.plan_id,
            ticker: row.ticker,
            code: row.code,
            qty: execution.execution?.submitted_qty || 0,
            allocations,
            reason_by_line: reasonByLine,
          });
        }
      }
    }
    row.updated_at = now.toISOString();
  }
  await persist();
  return { orders, positions, exposure: accountExposure(positions, orders, currentSessionDate) };
}

async function writeStatus(payload) {
  await writeJson(statusPath, {
    updated_at: new Date().toISOString(),
    business_line: ACTIVE_BUSINESS_LINE,
    strategy: ACTIVE_STRATEGY,
    strategy_label: FLOW_HEATMAP_MODE ? 'JUNKMAN-FLOW-HEATMAP' : 'JUNKMAN-MULTI',
    execution_environment: 'simulate_only',
    real_trading_allowed: false,
    paper_equity_usd_per_line: 10_000,
    line_count: 7,
    ...payload,
  });
}

function experimentReport(manifest, state) {
  const performance = summarize_junk_exit_experiment(state);
  const lines = performance.lines.length > 0
    ? performance.lines
    : manifest.lines.map((line) => ({
      manifest_hash: manifest.manifest_hash,
      experiment_version: manifest.version,
      experiment_line_id: line.line_id,
      label: line.label,
      control: line.control,
      paper_equity_usd: 10_000,
      cohort_count: 0,
      closed_trade_count: 0,
      win_count: 0,
      loss_count: 0,
      realized_pnl_usd: 0,
      realized_pnl_to_date_usd: 0,
      open_contract_qty: 0,
      win_rate_pct: null,
      return_on_paper_equity_pct: 0,
    }));
  return {
    manifest,
    performance: {
      ...performance,
      experiment_id: manifest.experiment_id,
      enabled: manifest.enabled,
      lines,
    },
  };
}

export async function runJunkMultiLine(cliArgs = process.argv.slice(2)) {
  const args = parseCliArgs(cliArgs);
  if (!businessLine.enabled) {
    throw new Error(`${ACTIVE_BUSINESS_LINE} is retired; only zero-dte-options may run. Historical records remain available.`);
  }
  if (flag(args['execute-real'])) throw new Error(`${ACTIVE_BUSINESS_LINE} is simulation-only.`);
  const statusOnly = flag(args.status) && !flag(args.watch) && !flag(args['execute-simulate']) && !flag(args['dry-run']);
  if (statusOnly) {
    const status = await parseJson(statusPath) || {
      phase: 'not_started',
      business_line: ACTIVE_BUSINESS_LINE,
      execution_environment: 'simulate_only',
      real_trading_allowed: false,
    };
    console.log(JSON.stringify(status, null, 2));
    return status;
  }

  const loaded = loadMoomooConfig(moomooConfigOptionsForBusinessLine(businessLine, args));
  let config = configureForFinalists(loaded, []);
  assertZeroDteSimulationOnly(config);
  const manifest = load_junk_exit_experiment(config.policy);
  if (!manifest.enabled || manifest.line_count !== 7 || manifest.total_paper_equity_usd !== 70_000) {
    throw new Error(`${ACTIVE_BUSINESS_LINE} requires exactly seven independent $10,000 virtual lines.`);
  }
  const executeSimulate = flag(args['execute-simulate']);
  const watch = flag(args.watch);
  const mode = executeSimulate ? 'execute_simulate' : 'dry_run';
  const releaseRuntimeLock = await acquireRuntimeLock();
  let state = normalizeState(await parseJson(statePath));
  let connection = null;
  let quoteFeed = null;
  let stopRequested = false;
  let lastDecision = null;
  const stop = () => { stopRequested = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const persist = async () => {
    state.updated_at = new Date().toISOString();
    await writeJson(statePath, state);
    await writeJson(experimentSummaryPath, experimentReport(manifest, state));
  };

  try {
    connection = await connectMoomoo(config, { timeoutMs: 25_000 });
    const accounts = await fetchMoomooAccounts(connection.client);
    const account = selectSimulatedUsOptionAccount(accounts);
    if (!account || Number(account.trdEnv) !== TRD_ENV_SIMULATE || Number(account.simAccType) !== 4) {
      throw new Error(`${ACTIVE_BUSINESS_LINE} requires the authenticated simulated US options account (simAccType=4).`);
    }
    config = { ...config, accId: String(account.accID), trdEnv: TRD_ENV_SIMULATE };
    quoteFeed = createMoomooQuoteFeed(connection.client, config);
    const nightwatch = FLOW_HEATMAP_MODE ? create_nightwatch_rest_client({
      base_url: 'https://api.yehangshe.com',
      api_key_env: 'YEHANGSHE_API_KEY',
      max_429_retries: 0,
      request_timeout_ms: finiteNumber(config.policy?.provider?.request_timeout_ms, 10_000),
      snapshot_rate_limiter: create_snapshot_rate_limiter({
        min_interval_ms: Math.max(1_000, finiteNumber(config.policy?.provider?.snapshot_min_interval_ms, 1_000)),
      }),
    }) : null;

    await writeStatus({ phase: 'starting', mode, process_id: process.pid });
    do {
      const cycleStarted = Date.now();
      const now = new Date(cycleStarted);
      const schedule = marketSchedule(config.policy, now);
      try {
        if (state.session_date_et !== schedule.date_key) {
          state.session_date_et = schedule.date_key;
          state.universe = null;
          state.last_flow_source_poll_at = null;
          state.gex_history_by_ticker = {};
          state.last_scanned_bucket_by_ticker = {};
          state.executed_signal_ids = [];
        }

        const broker = await reconcileRows({
          client: connection.client,
          config,
          quoteFeed,
          state,
          now,
          persist,
        });

        const requiredUniversePolicySignature = universePolicySignature(config.policy?.universe || {});
        if (FLOW_HEATMAP_MODE) {
          const flowPollIntervalMs = Math.max(
            30_000,
            finiteNumber(config.policy?.universe?.poll_interval_seconds, 30) * 1_000,
          );
          const flowPollDue = shouldPollFlowSource({
            universe_present: Boolean(state.universe),
            last_poll_at: state.last_flow_source_poll_at,
            now_ms: Date.now(),
            poll_interval_seconds: flowPollIntervalMs / 1_000,
          });
          if (flowPollDue) {
            const sourcePollAt = Date.now();
            const source = await readRecentUnusualFlowSeeds(sourceFlowEventsPath, {
              session_date_et: schedule.date_key,
              now_ms: sourcePollAt,
              max_event_age_ms: Math.max(
                30_000,
                finiteNumber(config.policy?.strategy?.flow_event_max_age_seconds, 300) * 1_000,
              ),
            });
            state.last_flow_source_poll_at = new Date(sourcePollAt).toISOString();
            if (
              !state.universe
              || state.universe.session_date_et !== schedule.date_key
              || state.universe.policy_signature !== requiredUniversePolicySignature
              || state.universe.source_signature !== source.source_signature
            ) {
              state.universe = await refreshFlowHeatmapUniverse({
                client: connection.client,
                nightwatch,
                config,
                sessionDateEt: schedule.date_key,
                source,
                previousUniverse: state.universe,
              });
              state.universe.policy_signature = requiredUniversePolicySignature;
              await writeJson(universePath, state.universe);
              await persist();
            }
          }
        } else {
          const source = readJunkmanAnalysisPlanSource(junkmanAnalysisPlansPath, {
            session_date_et: schedule.date_key,
            reserved_underlyings: config.policy?.universe?.reserved_underlyings || ['SPX'],
          });
          if (shouldRefreshDiscordPlanUniverse({
            entry_open: schedule.entry_open,
            universe: state.universe,
            session_date_et: schedule.date_key,
            policy_signature: requiredUniversePolicySignature,
            source_signature: source.source_signature,
          })) {
            state.universe = await refreshDailyPlanUniverse({
              client: connection.client,
              config,
              sessionDateEt: schedule.date_key,
              source,
              previousUniverse: state.universe,
            });
            await writeJson(universePath, state.universe);
            await persist();
          }
        }
        config = configureForFinalists(config, state.universe?.finalists || []);

        const decisions = [];
        if (schedule.entry_open && activeRows(state).length === 0 && (await activeOtherJunkRows()).length === 0) {
          let previousHistoryProbeAt = null;
          for (const finalist of state.universe.finalists || []) {
            try {
              if (!FLOW_HEATMAP_MODE && previousHistoryProbeAt !== null) {
                const intervalMs = Math.max(
                  1_000,
                  finiteNumber(config.policy?.universe?.underlying_history_probe_interval_ms, 1_100),
                );
                await sleep(Math.max(0, intervalMs - (Date.now() - previousHistoryProbeAt)));
              }
              previousHistoryProbeAt = Date.now();
              const marketContext = await ownSymbolMarketContext(
                connection.client,
                finalist.ticker,
                schedule.date_key,
                Date.now(),
              );
              if (!marketContext.price_action_ready || marketContext.bars_5m.length < 1) continue;
              const bucket = marketContext.expected_bucket_at;
              const scanKey = bucket;
              if (!bucket || state.last_scanned_bucket_by_ticker[finalist.ticker] === scanKey) continue;
              state.last_scanned_bucket_by_ticker[finalist.ticker] = scanKey;
              const evaluated = await evaluateTicker({
                nightwatch,
                config,
                finalist,
                marketContext,
                history: state.gex_history_by_ticker[finalist.ticker],
                nowMs: Date.now(),
              });
              state.gex_history_by_ticker[finalist.ticker] = evaluated.history;
              decisions.push(evaluated.decision);
              await appendJsonLine(decisionsPath, evaluated.decision);
            } catch (error) {
              const decision = {
                generated_at: new Date().toISOString(),
                business_line: ACTIVE_BUSINESS_LINE,
                strategy: ACTIVE_STRATEGY,
                ticker: finalist.ticker,
                decision: 'no_trade',
                action: 'hold',
                reason_codes: [`ticker_scan_failed_closed:${sanitizedError(error)}`],
              };
              decisions.push(decision);
              await appendJsonLine(decisionsPath, decision);
            }
          }
        }

        const selectedCandidate = decisions.filter((decision) => decision.decision === 'trade').sort(rankTradeDecisions)[0] || null;
        const selected = selectedCandidate ? { ...selectedCandidate, generated_at: new Date().toISOString() } : null;
        lastDecision = selected || decisions.at(-1) || lastDecision;
        if (selected && !state.executed_signal_ids.includes(selected.signal_id)) {
          let plan = await prepareZeroDteSimulatedEntry({
            client: connection.client,
            signal: selected,
            config,
            risk_state: {
              open_position_count: activeRows(state).length,
              daily_trade_count: 0,
              daily_realized_pnl_usd: 0,
              last_entry_at: null,
              executed_signal_ids: new Set(state.executed_signal_ids),
              flow_source_connected: false,
            },
            now: new Date(),
            quote_feed: quoteFeed,
          });
          plan = build_junk_experiment_cohort(plan, manifest);
          const releaseEntryLock = executeSimulate && plan.gate.passed
            ? await acquireSimulatedOptionsEntryLock({
              business_line: ACTIVE_BUSINESS_LINE,
              signal_id: plan.signal?.signal_id,
            })
            : async () => {};
          try {
            const [ordersResponse, positionsResponse] = await Promise.all([
              fetchOrderList(connection.client, config),
              fetchPositionList(connection.client, config),
            ]);
            const exposure = scopedEntryExposure(
              brokerRows(positionsResponse, 'positionList'),
              brokerRows(ordersResponse, 'orderList'),
              plan.order?.code,
              schedule.date_key,
            );
            if (!exposure.clear) {
              plan = {
                ...plan,
                order_status: 'gate_failed',
                gate: {
                  ...plan.gate,
                  passed: false,
                  reasons: [...new Set([...(plan.gate.reasons || []), 'shared_simulated_option_account_not_flat'])],
                },
              };
            }
            await appendJsonLine(entryPlansPath, plan);
            if (executeSimulate && plan.gate.passed) {
              const intent = entryRowFromExecution(plan, { execution: { submitted: false } }, new Date());
              intent.status = 'entry_intent';
              state.orders[plan.plan_id] = intent;
              state.executed_signal_ids = [...new Set([...state.executed_signal_ids, plan.signal.signal_id])].slice(-1_000);
              await persist();
              let execution;
              try {
                execution = await executeZeroDteSimulatedEntry({
                  client: connection.client,
                  config,
                  plan,
                  now: new Date(),
                });
              } catch (error) {
                intent.status = error?.submission_outcome === 'not_submitted'
                  ? 'entry_unfilled_terminal'
                  : 'entry_submission_unknown';
                intent.last_error = sanitizedError(error);
                await persist();
                if (error?.submission_outcome !== 'not_submitted') throw error;
              }
              if (execution) {
                const row = entryRowFromExecution(plan, execution, new Date());
                state.orders[plan.plan_id] = row;
                await appendJsonLine(entryPlansPath, execution);
                await appendJsonLine(tradesPath, {
                  event: 'entry_order_submitted',
                  at: new Date().toISOString(),
                  plan_id: row.plan_id,
                  signal_id: row.signal_id,
                  ticker: row.ticker,
                  code: row.code,
                  aggregate_qty: row.submitted_qty,
                  line_count: 7,
                  paper_equity_usd_per_line: 10_000,
                });
                await persist();
              }
            }
          } finally {
            await releaseEntryLock();
          }
        }

        state.last_error = null;
        await persist();
        await writeStatus({
          phase: watch ? (executeSimulate ? 'watching_simulation' : 'watching_plan') : 'cycle_complete',
          mode,
          process_id: process.pid,
          session_date_et: schedule.date_key,
          market_schedule: schedule,
          universe: state.universe ? {
            source: state.universe.source,
            source_status: state.universe.source_status,
            source_signature: state.universe.source_signature,
            published_plan_count: state.universe.published_plan_count,
            intersected_candidate_count: state.universe.intersected_candidate_count,
            finalist_count: state.universe.finalists.length,
            policy_signature: state.universe.policy_signature,
            finalists: state.universe.finalists.map((row) => ({
              ticker: row.ticker,
              source_plan_message_id: row.plan_message_id || null,
              source_plan_strategy_title: row.plan_strategy_title || null,
              option_contract_count: row.option_contract_count,
              option_strike_step_points: row.option_strike_step_points,
              zero_dte_chain_verified: true,
            })),
          } : null,
          moomoo: {
            connected: true,
            simulated_us_options_account: true,
            sim_acc_type: 4,
          },
          account_exposure: broker.exposure,
          active_orders: activeRows(state).map(compactRow),
          experiment: experimentReport(manifest, state),
          last_decision: lastDecision ? {
            generated_at: lastDecision.generated_at,
            ticker: lastDecision.ticker,
            decision: lastDecision.decision,
            reason_codes: lastDecision.reason_codes,
          } : null,
          last_error: null,
        });
      } catch (error) {
        state.last_error = sanitizedError(error);
        await persist();
        await writeStatus({
          phase: watch ? 'degraded_retrying' : 'cycle_failed',
          mode,
          process_id: process.pid,
          session_date_et: state.session_date_et,
          universe: state.universe,
          active_orders: activeRows(state).map(compactRow),
          experiment: experimentReport(manifest, state),
          last_error: state.last_error,
        });
        if (!watch) throw error;
      }
      if (!watch || stopRequested) break;
      await sleep(Math.max(0, POLL_MS - (Date.now() - cycleStarted)));
    } while (!stopRequested);
  } finally {
    await quoteFeed?.close?.().catch(() => {});
    connection?.close?.();
    await releaseRuntimeLock();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  if (stopRequested) {
    await writeStatus({
      phase: 'stopped',
      mode,
      process_id: process.pid,
      session_date_et: state.session_date_et,
      active_orders: activeRows(state).map(compactRow),
      experiment: experimentReport(manifest, state),
      last_error: state.last_error,
    });
  }
  return { state, last_decision: lastDecision };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isMain = invokedPath
  && path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === invokedPath.toLowerCase();
if (isMain) {
  runJunkMultiLine().catch(async (error) => {
    const message = sanitizedError(error);
    try {
      if (businessLine.enabled) {
        await writeStatus({ phase: 'fatal', mode: 'unknown', process_id: process.pid, last_error: message });
      }
    } catch {
      // Preserve the original failure.
    }
    console.error(message);
    process.exitCode = 1;
  });
}
