import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  QOT_MARKET_US_SECURITY,
  TRD_ENV_SIMULATE,
  cancelOrder,
  connectMoomoo,
  createMoomooQuoteFeed,
  ensureDir,
  fetchMoomooAccounts,
  fetchOrderFillList,
  fetchOrderList,
  fetchPositionList,
  getSecuritySnapshots,
  loadMoomooConfig,
  maskId,
  normalizeForJson,
  parseCliArgs,
  selectSimulatedUsOptionAccount,
} from '../../packages/moomoo-opend/moomoo-opend.mjs';
import {
  businessLineLogPath,
  moomooConfigOptionsForBusinessLine,
  resolveBusinessLine,
} from '../../packages/business-lines/business-lines.mjs';
import {
  create_nightwatch_rest_client,
  create_snapshot_rate_limiter,
} from '../../packages/nightwatch-api/nightwatch-rest-client.mjs';
import {
  evaluate_junk_gex_strategy,
  normalize_gex_snapshot,
} from './junk-gex-strategy.mjs';
import { create_junk_gex_market_context } from './junk-gex-market-context.mjs';
import { create_junk_flow_context } from './junk-flow-context.mjs';
import {
  apply_junk_contract_audit,
  audit_junk_contract_candidate,
  degraded_junk_contract_audit,
  junk_contract_audit_cache_key,
  read_junk_contract_audit_cache,
  write_junk_contract_audit_cache,
} from './junk-api-evidence.mjs';
import { apply_junk_v3_evidence } from './junk-trading-model-v2.mjs';
import {
  JUNK_GEX_STRATEGY,
  ZERO_DTE_BUSINESS_LINE,
  assertZeroDteSimulationOnly,
  executeZeroDteSimulatedEntry,
  prepareZeroDteSimulatedEntry,
} from './zero-dte-moomoo-executor.mjs';
import {
  buildZeroDteSimulatedExitPlan,
  buildZeroDteSimulatedExplicitExitPlan,
  executeZeroDteSimulatedExit,
} from './zero-dte-moomoo-exit.mjs';
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
  finalize_junk_experiment_unpriced_entry_allocation,
  load_junk_exit_experiment,
  summarize_junk_exit_experiment,
  update_junk_experiment_variant_management,
} from './junk-exit-experiment.mjs';
import flowAlertParser from '../../packages/option-signals/nightwatch-0dte-flow-alert.cjs';

const {
  MAX_LIVE_CAPTURE_LAG_MS,
  NIGHTWATCH_GUILD_ID,
  NIGHTWATCH_ZERO_DTE_FLOW_BOT_AUTHOR_ID,
  NIGHTWATCH_ZERO_DTE_FLOW_CHANNEL_ID,
} = flowAlertParser;

const business_line = resolveBusinessLine(ZERO_DTE_BUSINESS_LINE);
const status_path = businessLineLogPath(business_line, 'status.json');
const state_path = businessLineLogPath(business_line, 'runtime-state.json');
const decisions_path = businessLineLogPath(business_line, 'decisions.ndjson');
const entry_plans_path = businessLineLogPath(business_line, 'entry-plans.ndjson');
const exit_plans_path = businessLineLogPath(business_line, 'exit-plans.ndjson');
const trades_path = businessLineLogPath(business_line, 'trades.ndjson');
const experiment_events_path = businessLineLogPath(business_line, 'experiment-events.ndjson');
const experiment_summary_path = businessLineLogPath(business_line, 'experiment-summary.json');
const flow_events_path = businessLineLogPath(business_line, 'flow-events.ndjson');
const capture_status_path = path.join(path.dirname(status_path), 'capture-status.json');
const runtime_lock_path = businessLineLogPath(business_line, 'runtime.lock.json');
const spy_security = Object.freeze({ market: QOT_MARKET_US_SECURITY, code: 'SPY' });

function flag(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function finite_number(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive_number(value, fallback = null) {
  const parsed = finite_number(value);
  return parsed !== null && parsed > 0 ? parsed : fallback;
}

function sleep(delay_ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delay_ms)));
}

async function with_timeout(promise, timeout_ms, label) {
  let timeout_id;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timeout_id = setTimeout(() => reject(new Error(`${label} timed out after ${timeout_ms}ms`)), timeout_ms);
      }),
    ]);
  } finally {
    clearTimeout(timeout_id);
  }
}

function sanitized_error(error) {
  let raw;
  if (error?.message) raw = String(error.message);
  else {
    try { raw = JSON.stringify(normalizeForJson(error)); } catch { raw = String(error || 'unknown error'); }
  }
  return raw
    .replace(/sk_(?:live|test)_[A-Za-z0-9_-]+/g, '[redacted_api_key]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .slice(0, 1000);
}

async function parse_json_file(file_path) {
  try {
    return { found: true, value: JSON.parse(await fsp.readFile(file_path, 'utf8')), error: null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { found: false, value: null, error: null };
    return { found: true, value: null, error };
  }
}

async function read_json(file_path, fallback) {
  const primary = await parse_json_file(file_path);
  if (primary.value !== null) return primary.value;
  const backup = await parse_json_file(`${file_path}.bak`);
  if (backup.value !== null) return backup.value;
  return fallback;
}

async function write_json(file_path, payload) {
  await ensureDir(path.dirname(file_path));
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const temporary_path = `${file_path}.${process.pid}.${randomUUID()}.tmp`;
  let handle = null;
  try {
    handle = await fsp.open(temporary_path, 'wx');
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporary_path, file_path);
    await fsp.copyFile(file_path, `${file_path}.bak`);
  } finally {
    await handle?.close().catch(() => {});
    await fsp.unlink(temporary_path).catch(() => {});
  }
}

async function append_json_line(file_path, payload) {
  await ensureDir(path.dirname(file_path));
  await fsp.appendFile(file_path, `${JSON.stringify(payload)}\n`, 'utf8');
}

function experiment_line_ids(row) {
  return Object.keys(row?.experiment_ledger?.variants || {}).sort();
}

export function is_junk_experiment_row(row) {
  return Boolean(row?.experiment_ledger?.experiment_id && row?.experiment_ledger?.cohort_id);
}

function experiment_event_fields(row, extra = {}) {
  if (!is_junk_experiment_row(row)) return extra;
  return {
    experiment_id: row.experiment_ledger.experiment_id,
    cohort_id: row.experiment_ledger.cohort_id,
    line_ids: experiment_line_ids(row),
    ...extra,
  };
}

async function write_experiment_event(event, row, payload = {}) {
  if (!is_junk_experiment_row(row)) return;
  await append_json_line(experiment_events_path, {
    event_at: new Date().toISOString(),
    event,
    business_line: ZERO_DTE_BUSINESS_LINE,
    strategy: JUNK_GEX_STRATEGY,
    execution_environment: 'simulate_only',
    ...experiment_event_fields(row),
    ...payload,
  });
}

export function junk_experiment_entry_risk_state(base_risk_state, manifest, experiment_summary = null) {
  if (!manifest?.enabled || manifest.line_count < 1) return base_risk_state;
  const line_pnls = (experiment_summary?.session_lines || experiment_summary?.lines || [])
    .map((line) => finite_number(line?.realized_pnl_to_date_usd, finite_number(line?.realized_pnl_usd)))
    .filter((value) => value !== null);
  const raw_worst_line_realized_pnl_usd = line_pnls.length > 0
    ? Math.min(...line_pnls)
    : 0;
  const unallocated_realized_pnl_usd = finite_number(
    experiment_summary?.session_unallocated_realized_pnl_usd
      ?? experiment_summary?.unallocated_realized_pnl_usd,
    0,
  );
  const risk_adjusted_realized_pnl_usd = Number((
    raw_worst_line_realized_pnl_usd + Math.min(0, unallocated_realized_pnl_usd)
  ).toFixed(2));
  const aggregate_daily_realized_pnl_usd = finite_number(base_risk_state?.daily_realized_pnl_usd, 0);
  const conservative_daily_realized_pnl_usd = Math.min(
    aggregate_daily_realized_pnl_usd,
    risk_adjusted_realized_pnl_usd,
  );
  return {
    ...base_risk_state,
    // The configured $300 stop is a per-$10k-line limit. A new paired cohort is
    // blocked as soon as the worst line reaches that loss, even when aggregate
    // PnL is masked by wins in the other variants.
    daily_realized_pnl_usd: conservative_daily_realized_pnl_usd,
    aggregate_daily_realized_pnl_usd,
    worst_line_realized_pnl_usd: raw_worst_line_realized_pnl_usd,
    unallocated_realized_pnl_usd,
    risk_adjusted_realized_pnl_usd,
    experiment_line_count: manifest.line_count,
  };
}

export function junk_experiment_manifest_conflicts(state, manifest) {
  if (!manifest?.enabled) return [];
  return Object.values(state?.orders || {}).filter((row) => {
    if (!is_junk_experiment_row(row)) return false;
    const pending_entry = ['entry_intent', 'entry_submission_unknown', 'entry_submitted',
      'entry_partial_cancel_pending', 'entry_allocation_waiting_terminal'].includes(String(row.status || ''));
    const physical_ownership_evidence = finite_number(row.filled_qty, 0) > finite_number(row.exited_qty, 0)
      || experiment_total_remaining_qty(row.experiment_ledger) > 0
      || Boolean(row.experiment_ledger.pending_exit_batch);
    const locks_manifest = !terminal_order_state(row.status) || pending_entry || physical_ownership_evidence;
    return locks_manifest && row.experiment_ledger.manifest_hash !== manifest.manifest_hash;
  });
}

export function build_junk_experiment_entry_cohort(base_plan, manifest, policy = {}) {
  let plan = build_junk_experiment_cohort(base_plan, manifest);
  if (!manifest?.enabled || policy?.execution_quality?.cap_qty_by_visible_ask !== true) return plan;
  const ask_size = positive_number(base_plan?.quote?.ask_size_contracts);
  if (ask_size !== null) return plan;
  const reason = finite_number(base_plan?.quote?.ask_size_contracts) !== null
    ? 'experiment_visible_ask_size_nonpositive'
    : 'experiment_visible_ask_size_missing';
  plan = {
    ...plan,
    order_status: 'gate_failed',
    gate: {
      ...(plan.gate || {}),
      passed: false,
      reasons: [...new Set([...(plan.gate?.reasons || []), reason])],
    },
  };
  return plan;
}

export function junk_experiment_ownership_invariant(row, broker_position = null) {
  if (!is_junk_experiment_row(row) || row.experiment_ledger.entry_allocation_finalized !== true) {
    return { passed: true, applicable: false, reasons: [] };
  }
  const ledger_remaining_qty = experiment_total_remaining_qty(row.experiment_ledger);
  const physical_remaining_qty = Math.max(
    0,
    Math.floor(finite_number(row.filled_qty, 0) - finite_number(row.exited_qty, 0)),
  );
  const broker_position_qty = Math.max(0, Math.floor(finite_number(broker_position?.qty, 0)));
  const reasons = [];
  if (ledger_remaining_qty !== physical_remaining_qty) {
    reasons.push(`experiment_ledger_physical_qty_mismatch:${ledger_remaining_qty}:${physical_remaining_qty}`);
  }
  if (broker_position_qty !== ledger_remaining_qty) {
    reasons.push(`experiment_broker_ledger_qty_mismatch:${broker_position_qty}:${ledger_remaining_qty}`);
  }
  return {
    passed: reasons.length === 0,
    applicable: true,
    reasons,
    ledger_remaining_qty,
    physical_remaining_qty,
    broker_position_qty,
  };
}

function process_is_running(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed < 1) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function acquire_runtime_lock() {
  await ensureDir(path.dirname(runtime_lock_path));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const owner_token = randomUUID();
    try {
      const handle = await fsp.open(runtime_lock_path, 'wx');
      await handle.writeFile(`${JSON.stringify({
        process_id: process.pid,
        owner_token,
        business_line: ZERO_DTE_BUSINESS_LINE,
        acquired_at: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');
      await handle.close();
      return async () => {
        const current = await read_json(runtime_lock_path, null);
        if (Number(current?.process_id) === process.pid && current?.owner_token === owner_token) {
          await fsp.unlink(runtime_lock_path).catch(() => {});
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = await read_json(runtime_lock_path, null);
      if (process_is_running(current?.process_id)) {
        throw new Error(`JUNKMAN GEX runtime is already active under process ${current.process_id}.`);
      }
      const quarantine_path = `${runtime_lock_path}.stale.${process.pid}.${randomUUID()}`;
      try {
        await fsp.rename(runtime_lock_path, quarantine_path);
        await fsp.unlink(quarantine_path).catch(() => {});
      } catch (rename_error) {
        if (!['ENOENT', 'EACCES', 'EPERM'].includes(rename_error?.code)) throw rename_error;
      }
    }
  }
  throw new Error('Unable to acquire the JUNKMAN GEX runtime lock.');
}

function ny_context(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour === '24' ? 0 : values.hour);
  const minute = Number(values.minute);
  return {
    date_key: `${values.year}-${values.month}-${values.day}`,
    weekday: values.weekday,
    hour,
    minute,
    second: Number(values.second),
    minutes: hour * 60 + minute,
  };
}

function is_weekday(ny) {
  return !['Sat', 'Sun'].includes(ny.weekday);
}

function parse_et_minutes(value, fallback) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)
    || hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return hour * 60 + minute;
}

export function market_schedule(policy, ny) {
  const calendar = policy?.market_calendar || {};
  const closed_dates = new Set(Array.isArray(calendar.closed_dates_et) ? calendar.closed_dates_et.map(String) : []);
  const early_dates = new Set(Array.isArray(calendar.early_close_dates_et) ? calendar.early_close_dates_et.map(String) : []);
  const calendar_valid = /^\d{4}-\d{2}-\d{2}$/.test(String(calendar.valid_through_et || ''))
    && ny.date_key <= String(calendar.valid_through_et);
  const closed = !is_weekday(ny) || closed_dates.has(ny.date_key) || !calendar_valid;
  const early_close = !closed && early_dates.has(ny.date_key);
  const close_exit_start_minutes = early_close
    ? parse_et_minutes(calendar.early_close_exit_start_time_et, 12 * 60 + 30)
    : parse_et_minutes(policy?.exit_rules?.close_exit_start_time_et, 15 * 60 + 30);
  const force_close_start_minutes = early_close
    ? parse_et_minutes(calendar.early_force_close_exit_start_time_et, 12 * 60 + 45)
    : parse_et_minutes(policy?.exit_rules?.force_close_exit_start_time_et, 15 * 60 + 45);
  const session_close_minutes = early_close
    ? parse_et_minutes(calendar.early_session_close_time_et, 13 * 60)
    : 16 * 60;
  const entry_start_minutes = parse_et_minutes(policy?.strategy?.entry_start_time_et, 9 * 60 + 35);
  const entry_cutoff_minutes = parse_et_minutes(policy?.strategy?.entry_cutoff_time_et, 15 * 60 + 20);
  return {
    calendar_valid,
    closed,
    early_close,
    session_open_minutes: 9 * 60 + 30,
    close_exit_start_minutes,
    force_close_start_minutes,
    session_close_minutes,
    entry_start_minutes,
    entry_cutoff_minutes,
    market_open: !closed && ny.minutes >= 9 * 60 + 30 && ny.minutes < session_close_minutes,
    entry_open: !closed
      && ny.minutes >= entry_start_minutes
      && ny.minutes < Math.min(entry_cutoff_minutes, close_exit_start_minutes, session_close_minutes),
  };
}

function is_regular_session_window(ny, policy) {
  return market_schedule(policy, ny).market_open;
}

function exit_config_for_schedule(config, schedule) {
  if (!schedule.early_close) return config;
  const calendar = config.policy?.market_calendar || {};
  const schedule_exit_rule_overrides = {
    close_exit_start_time_et: calendar.early_close_exit_start_time_et || '12:30',
    force_close_exit_start_time_et: calendar.early_force_close_exit_start_time_et || '12:45',
  };
  return {
    ...config,
    schedule_exit_rule_overrides,
    policy: {
      ...config.policy,
      exit_rules: {
        ...(config.policy?.exit_rules || {}),
        ...schedule_exit_rule_overrides,
      },
    },
  };
}

function default_state() {
  return {
    schema_version: 3,
    business_line: ZERO_DTE_BUSINESS_LINE,
    strategy: JUNK_GEX_STRATEGY,
    session_date_et: null,
    started_at: new Date().toISOString(),
    updated_at: null,
    daily_trade_count: 0,
    daily_realized_pnl_usd: 0,
    last_entry_at: null,
    executed_signal_ids: [],
    orders: {},
    broker_recovery: {
      status: 'pending',
      checked_at: null,
      recovered_order_count: 0,
      source_state: 'new',
    },
    provider_blocked_until: null,
    gex_node_history: [],
    market_context: {
      samples: [],
      bars_1m: [],
    },
    quota: null,
    heatmap: null,
    contract_audit_cache: {},
    experiment_manifest: null,
  };
}

function normalized_state(state) {
  const base = default_state();
  const source = state && typeof state === 'object' ? state : {};
  return {
    ...base,
    ...source,
    schema_version: Math.max(3, Math.trunc(finite_number(source.schema_version, 0))),
    business_line: ZERO_DTE_BUSINESS_LINE,
    strategy: JUNK_GEX_STRATEGY,
    executed_signal_ids: Array.isArray(source.executed_signal_ids)
      ? [...new Set(source.executed_signal_ids.map(String))].slice(-1000)
      : [],
    orders: source.orders && typeof source.orders === 'object' ? source.orders : {},
    broker_recovery: source.broker_recovery && typeof source.broker_recovery === 'object'
      ? source.broker_recovery
      : base.broker_recovery,
    gex_node_history: Array.isArray(source.gex_node_history) ? source.gex_node_history.slice(-240) : [],
    market_context: source.market_context && typeof source.market_context === 'object'
      ? source.market_context
      : base.market_context,
    contract_audit_cache: source.contract_audit_cache
      && typeof source.contract_audit_cache === 'object'
      && !Array.isArray(source.contract_audit_cache)
      ? source.contract_audit_cache
      : {},
    experiment_manifest: source.experiment_manifest
      && typeof source.experiment_manifest === 'object'
      && !Array.isArray(source.experiment_manifest)
      ? source.experiment_manifest
      : null,
  };
}

async function load_runtime_state() {
  const primary = await parse_json_file(state_path);
  if (primary.value !== null) {
    const state = normalized_state(primary.value);
    state.broker_recovery = {
      ...state.broker_recovery,
      status: 'pending',
      source_state: recovery_source_on_load(state.broker_recovery, 'primary'),
    };
    return state;
  }
  const backup = await parse_json_file(`${state_path}.bak`);
  if (backup.value !== null) {
    const state = normalized_state(backup.value);
    state.broker_recovery = {
      ...state.broker_recovery,
      status: 'pending',
      source_state: recovery_source_on_load(state.broker_recovery, 'backup'),
    };
    return state;
  }
  const state = default_state();
  state.broker_recovery = {
    ...state.broker_recovery,
    status: 'pending',
    source_state: primary.found || backup.found ? 'corrupt_fail_closed' : 'new',
  };
  return state;
}

export function recovery_source_on_load(existing_recovery, loaded_from) {
  const existing_source = String(existing_recovery?.source_state || '');
  const blocked_for_unowned_positions = existing_recovery?.status === 'blocked'
    && existing_recovery?.error_code === 'unowned_simulated_option_positions_with_untrusted_local_state';
  if (blocked_for_unowned_positions
    && ['new', 'backup', 'corrupt_fail_closed'].includes(existing_source)) return existing_source;
  return String(loaded_from || 'unknown');
}

function terminal_order_state(status) {
  return [
    'closed',
    'entry_unfilled_terminal',
    'entry_cancelled',
    'submit_failed',
    'expired_settled_unpriced',
    'expired_no_submission_evidence',
  ].includes(String(status));
}

function active_order_rows(state) {
  return Object.values(state.orders || {}).filter((row) => !terminal_order_state(row?.status));
}

export function junk_experiment_ownership_rows(state) {
  return Object.values(state?.orders || {});
}

function open_position_count(state) {
  return active_order_rows(state).length;
}

function experiment_cohorts_allow_new_entry(state) {
  return Object.values(state?.orders || {}).every((row) => {
    if (!is_junk_experiment_row(row)) return true;
    if (finite_number(row.filled_qty, 0) <= 0 && terminal_order_state(row.status)) return true;
    return experiment_all_variants_flat(row.experiment_ledger);
  });
}

export function experiment_unpriced_incident_blocks_new_entry(state) {
  return Object.values(state?.orders || {}).some((row) => (
    is_junk_experiment_row(row) && row.experiment_unpriced_force_close === true
  ));
}

export function junk_experiment_unpriced_emergency_window({
  schedule,
  force_close,
  expiration,
  session_date_et,
} = {}) {
  return schedule?.market_open === true
    && force_close === true
    && typeof expiration === 'string'
    && expiration.length > 0
    && expiration === session_date_et;
}

function compact_order(row) {
  const compact = {
    plan_id: row.plan_id,
    signal_id: row.signal_id,
    status: row.status,
    code: row.code,
    submitted_qty: row.submitted_qty,
    filled_qty: row.filled_qty || 0,
    exited_qty: row.exited_qty || 0,
    entry_fill_price: row.entry_fill_price || null,
    option_return_pct: row.option_return_pct ?? null,
    peak_option_return_pct: row.peak_option_return_pct ?? null,
    breakeven_armed: row.breakeven_armed === true,
    entry_order_id: row.entry_order_id || null,
    entry_order_id_ex: row.entry_order_id_ex || null,
    exit_order_id: row.exit_order_id || null,
    exit_order_id_ex: row.exit_order_id_ex || null,
    updated_at: row.updated_at || null,
  };
  if (!is_junk_experiment_row(row)) return compact;
  return {
    ...compact,
    experiment_id: row.experiment_ledger.experiment_id,
    cohort_id: row.experiment_ledger.cohort_id,
    line_ids: experiment_line_ids(row),
    entry_allocation_finalized: row.experiment_ledger.entry_allocation_finalized === true,
    allocation_quality: row.experiment_ledger.allocation_quality || null,
    per_line_remaining_qty: Object.fromEntries(Object.entries(row.experiment_ledger.variants || {})
      .map(([line_id, variant]) => [line_id, experiment_variant_remaining_qty(variant)])),
    unallocated_remaining_qty: experiment_unallocated_remaining_qty(row.experiment_ledger),
    aggregate_ledger_remaining_qty: experiment_total_remaining_qty(row.experiment_ledger),
  };
}

function quota_summary(discover_response) {
  const data = discover_response?.data || discover_response || {};
  const quota = data.quota || {};
  return {
    api_version: data.api_version || null,
    monthly_limit: finite_number(quota.monthly_limit),
    monthly_remaining: finite_number(quota.monthly_remaining),
    monthly_reset_at: quota.monthly_reset_at || null,
    rpm_limit: finite_number(quota.rpm_limit),
    in_flight_max: finite_number(quota.in_flight_max),
    capabilities_count: Array.isArray(data.capabilities) ? data.capabilities.length : null,
    checked_at: new Date().toISOString(),
  };
}

function heatmap_summary(response) {
  const data = response?.data || response || {};
  const row_stacks = Array.isArray(data.row_stacks) ? data.row_stacks : null;
  return {
    fetched_at: new Date().toISOString(),
    generated_at: data.generated_at || null,
    session_date_et: data.session_date_et || null,
    market_status: data.market_status || null,
    state: data.state || null,
    spot_usd: finite_number(data.spot_usd),
    top_rows: row_stacks === null
      ? null
      : row_stacks
        .map((row) => ({
          strike_usd: finite_number(row.strike_usd),
          row_net_wall_gex_usd: finite_number(row.row_net_wall_gex_usd),
          row_abs_wall_gex_usd: finite_number(row.row_abs_wall_gex_usd),
          rank: finite_number(row.rank),
        }))
        .filter((row) => row.strike_usd !== null)
        .sort((left, right) => (left.rank ?? 999) - (right.rank ?? 999))
        .slice(0, 10),
  };
}

function nearest_heatmap_row(heatmap, strike) {
  const target = finite_number(strike);
  if (target === null || !Array.isArray(heatmap?.top_rows)) return null;
  return [...heatmap.top_rows]
    .sort((left, right) => Math.abs(left.strike_usd - target) - Math.abs(right.strike_usd - target))[0] || null;
}

function broker_rows(response, list_name) {
  const normalized = normalizeForJson(response);
  const rows = normalized?.s2c?.[list_name];
  return Array.isArray(rows) ? rows : [];
}

async function read_ndjson(file_path) {
  try {
    const text = await fsp.readFile(file_path, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function normalized_broker_id(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim();
  return normalized && normalized !== '0' ? normalized : null;
}

export function broker_order_identity(source) {
  return {
    order_id: normalized_broker_id(
      source?.orderID ?? source?.orderId ?? source?.broker_order_id ?? source?.order_id,
    ),
    order_id_ex: normalized_broker_id(
      source?.orderIDEx ?? source?.orderIdEx ?? source?.broker_order_id_ex ?? source?.order_id_ex,
    ),
  };
}

export function broker_order_keys(source) {
  const identity = broker_order_identity(source);
  return [
    identity.order_id_ex ? `ex:${identity.order_id_ex}` : null,
    identity.order_id ? `id:${identity.order_id}` : null,
  ].filter(Boolean);
}

function row_order_keys(row, prefix) {
  return broker_order_keys({
    order_id: row?.[`${prefix}_order_id`],
    order_id_ex: row?.[`${prefix}_order_id_ex`],
  });
}

export function apply_broker_order_identity(row, prefix, source) {
  const identity = broker_order_identity(source);
  if (identity.order_id) row[`${prefix}_order_id`] = identity.order_id;
  if (identity.order_id_ex) row[`${prefix}_order_id_ex`] = identity.order_id_ex;
  return identity;
}

export function has_broker_order_identity(source) {
  const identity = broker_order_identity(source);
  return Boolean(identity.order_id || identity.order_id_ex);
}

function row_has_order_identity(row, prefix) {
  return row_order_keys(row, prefix).length > 0;
}

function add_to_identity_map(map, row) {
  for (const key of broker_order_keys(row)) map.set(key, row);
}

function identity_map(rows) {
  const map = new Map();
  for (const row of rows) add_to_identity_map(map, row);
  return map;
}

function order_map(response) {
  return identity_map(broker_rows(response, 'orderList'));
}

function find_by_row_identity(map, row, prefix) {
  for (const key of row_order_keys(row, prefix)) {
    const found = map.get(key);
    if (found) return found;
  }
  return null;
}

function broker_order_id(row) {
  const identity = broker_order_identity(row);
  return identity.order_id_ex || identity.order_id || '';
}

function fills_for_identity(map, source) {
  const seen = new Set();
  const fills = [];
  for (const key of broker_order_keys(source)) {
    for (const fill of map.get(key) || []) {
      if (seen.has(fill)) continue;
      seen.add(fill);
      fills.push(fill);
    }
  }
  return fills;
}

function fill_identity_map(fills) {
  const map = new Map();
  for (const fill of fills) {
    for (const key of broker_order_keys(fill)) {
      const bucket = map.get(key) || [];
      bucket.push(fill);
      map.set(key, bucket);
    }
  }
  return map;
}

function broker_remark(row) {
  return String(row?.remark || '').trim();
}

function exit_remark_base(row) {
  return `junk_gex_exit:${String(row?.plan_id || '').slice(-20)}`.slice(0, 60);
}

export function build_exit_attempt_remark(plan_id, attempt_no) {
  const normalized_attempt = Math.max(1, Math.trunc(finite_number(attempt_no, 1)));
  return `${exit_remark_base({ plan_id })}:${normalized_attempt}`.slice(0, 60);
}

export function observed_exit_attempt_no(plan_id, exit_orders = []) {
  const prefix = `${exit_remark_base({ plan_id })}:`;
  return exit_orders.reduce((highest, order) => {
    const remark = broker_remark(order);
    if (!remark.startsWith(prefix)) return highest;
    const suffix = remark.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) return highest;
    return Math.max(highest, Math.trunc(finite_number(suffix, 0)));
  }, 0);
}

export function unresolved_exit_recovery_required(row, current_attempt_orders = []) {
  const status = String(row?.status || '');
  const has_current_attempt = Array.isArray(current_attempt_orders) && current_attempt_orders.length > 0;
  const tracks_exit_attempt = Boolean(row?.exit_remark) || row_has_order_identity(row, 'exit');
  return ['exit_intent', 'exit_submission_unknown', 'exit_submitted', 'recovery_blocked'].includes(status)
    && tracks_exit_attempt
    && !has_current_attempt;
}

export function seed_recovered_active_exit_accounting(row, total_exit_qty, total_exit_value, active_fill) {
  const active_qty = finite_number(active_fill?.qty, 0);
  const active_value = finite_number(active_fill?.value, 0);
  row.exited_qty = Math.min(
    finite_number(row.filled_qty, 0),
    Math.max(finite_number(row.exited_qty, 0), finite_number(total_exit_qty, 0)),
  );
  if (finite_number(total_exit_value, 0) > 0) {
    row.exit_fill_value = Number(finite_number(total_exit_value, 0).toFixed(8));
  }
  row.exit_base_exited_qty = Math.max(0, finite_number(total_exit_qty, 0) - active_qty);
  row.exit_order_accounted_fill_qty = active_qty;
  row.exit_order_accounted_fill_value = active_value;
  return row;
}

function broker_fill_summary(order, fills = []) {
  const order_qty = finite_number(order?.fillQty);
  const order_avg = positive_number(order?.fillAvgPrice);
  if (order_qty !== null && order_qty >= 0) {
    return {
      qty: order_qty,
      avg_price: order_avg,
      value: order_avg === null ? null : Number((order_qty * order_avg).toFixed(8)),
    };
  }
  let qty = 0;
  let value = 0;
  for (const fill of fills) {
    const fill_qty = finite_number(fill?.qty ?? fill?.fillQty, 0);
    const fill_price = positive_number(fill?.price ?? fill?.fillPrice);
    if (fill_qty <= 0 || fill_price === null) continue;
    qty += fill_qty;
    value += fill_qty * fill_price;
  }
  return {
    qty,
    avg_price: qty > 0 ? value / qty : null,
    value: qty > 0 ? Number(value.toFixed(8)) : null,
  };
}

function position_entry_cost(position) {
  return positive_number(
    position?.averageCostPrice
      ?? position?.average_cost_price
      ?? position?.dilutedCostPrice
      ?? position?.diluted_cost_price
      ?? position?.costPrice
      ?? position?.cost_price,
  );
}

export function resolve_junk_experiment_entry_fill({
  row,
  broker_order,
  fills = [],
  positions = [],
  ownership_rows = [],
} = {}) {
  const order_qty = Math.max(
    0,
    Math.floor(finite_number(broker_order?.fillQty, finite_number(row?.filled_qty, 0))),
  );
  const order_avg = positive_number(broker_order?.fillAvgPrice);
  if (order_qty > 0 && order_avg !== null) {
    return { qty: order_qty, avg_price: order_avg, source: 'broker_order_fill_average', trusted: true };
  }
  const list_fill = broker_fill_summary(null, fills);
  if (list_fill.qty > 0
    && list_fill.avg_price !== null
    && (order_qty < 1 || list_fill.qty === order_qty)) {
    return {
      qty: order_qty > 0 ? order_qty : list_fill.qty,
      avg_price: list_fill.avg_price,
      source: 'broker_fill_list_vwap',
      trusted: true,
    };
  }
  const persisted_source = String(row?.entry_fill_price_source || '');
  if (order_qty > 0
    && order_qty === Math.max(0, Math.floor(finite_number(row?.filled_qty, 0)))
    && positive_number(row?.entry_fill_price) !== null
    && ['broker_order_fill_average', 'broker_fill_list_vwap', 'single_owned_position_cost']
      .includes(persisted_source)) {
    return {
      qty: order_qty,
      avg_price: positive_number(row.entry_fill_price),
      source: persisted_source,
      trusted: true,
    };
  }
  const code = String(row?.code || broker_order?.code || '');
  const matching_positions = positions.filter((position) => (
    String(position?.code || '') === code && finite_number(position?.qty, 0) > 0
  ));
  const owning_rows = ownership_rows.filter((candidate) => (
    String(candidate?.code || '') === code
      && !terminal_order_state(candidate?.status)
      && (
        candidate === row
        || candidate?.plan_id === row?.plan_id
        || finite_number(candidate?.filled_qty, 0) > finite_number(candidate?.exited_qty, 0)
      )
  ));
  const position = matching_positions.length === 1 ? matching_positions[0] : null;
  const position_cost = position_entry_cost(position);
  const physical_remaining_qty = Math.max(
    0,
    Math.floor(Math.max(order_qty, finite_number(row?.filled_qty, 0)) - finite_number(row?.exited_qty, 0)),
  );
  const unique_owner = owning_rows.length === 1
    && (owning_rows[0] === row || owning_rows[0]?.plan_id === row?.plan_id);
  if (position
    && position_cost !== null
    && unique_owner
    && Math.floor(finite_number(position.qty, 0)) === physical_remaining_qty
    && order_qty > 0) {
    return { qty: order_qty, avg_price: position_cost, source: 'single_owned_position_cost', trusted: true };
  }
  return {
    qty: order_qty,
    avg_price: null,
    source: null,
    trusted: false,
    reason: order_qty > 0 ? 'experiment_entry_fill_average_missing' : 'experiment_entry_not_filled',
  };
}

export function prove_junk_experiment_unpriced_force_close_ownership({
  row,
  broker_order,
  positions = [],
  ownership_rows = [],
} = {}) {
  const reasons = [];
  if (!is_junk_experiment_row(row) || row?.orphan_experiment_entry === true) {
    reasons.push('experiment_virtual_ownership_missing');
  }
  const rowKeys = new Set(row_order_keys(row, 'entry'));
  const brokerKeys = broker_order_keys(broker_order);
  if (rowKeys.size < 1 || brokerKeys.length < 1 || !brokerKeys.some((key) => rowKeys.has(key))) {
    reasons.push('experiment_entry_order_identity_not_proven');
  }
  if (!is_terminal_broker_order(broker_order?.orderStatus)) {
    reasons.push('experiment_entry_order_not_terminal');
  }
  const brokerFilledQty = Math.max(0, Math.floor(finite_number(broker_order?.fillQty, 0)));
  const exitedQty = Math.max(0, Math.floor(finite_number(row?.exited_qty, 0)));
  const physicalRemainingQty = Math.max(0, brokerFilledQty - exitedQty);
  if (brokerFilledQty < 1 || physicalRemainingQty < 1) reasons.push('experiment_positive_owned_qty_not_proven');
  if (exitedQty > 0) reasons.push('experiment_unpriced_prior_exit_history_unsupported');
  if (finite_number(row?.submitted_qty, brokerFilledQty) < brokerFilledQty) {
    reasons.push('experiment_broker_fill_exceeds_submitted_qty');
  }
  const code = String(row?.code || broker_order?.code || '');
  if (!code || String(broker_order?.code || '') !== code) reasons.push('experiment_entry_contract_identity_mismatch');
  const matchingPositions = positions.filter((position) => (
    String(position?.code || '') === code && finite_number(position?.qty, 0) > 0
  ));
  if (matchingPositions.length !== 1) reasons.push('experiment_unique_broker_position_not_proven');
  const position = matchingPositions.length === 1 ? matchingPositions[0] : null;
  const brokerPositionQty = Math.max(0, Math.floor(finite_number(position?.qty, 0)));
  const brokerSellableQty = Math.max(0, Math.floor(finite_number(position?.canSellQty, brokerPositionQty)));
  if (position && brokerPositionQty !== physicalRemainingQty) {
    reasons.push(`experiment_broker_position_qty_mismatch:${brokerPositionQty}:${physicalRemainingQty}`);
  }
  if (position && brokerSellableQty < physicalRemainingQty) {
    reasons.push(`experiment_broker_sellable_qty_insufficient:${brokerSellableQty}:${physicalRemainingQty}`);
  }
  const competingOwners = ownership_rows.filter((candidate) => (
    candidate !== row
      && String(candidate?.code || '') === code
      && finite_number(candidate?.filled_qty, 0) > finite_number(candidate?.exited_qty, 0)
  ));
  const terminalCompetingOwners = competingOwners.filter((candidate) => (
    terminal_order_state(candidate?.status)
  ));
  if (terminalCompetingOwners.length > 0) {
    reasons.push('experiment_contract_has_terminal_local_owner_with_remaining_qty');
  }
  if (competingOwners.length > terminalCompetingOwners.length) {
    reasons.push('experiment_contract_has_competing_local_owner');
  }
  if (row?.experiment_ledger?.entry_allocation_finalized === true
    && experiment_total_remaining_qty(row.experiment_ledger) !== physicalRemainingQty) {
    reasons.push('experiment_existing_ledger_qty_mismatch');
  }
  return {
    passed: reasons.length === 0,
    reasons,
    broker_filled_qty: brokerFilledQty,
    physical_remaining_qty: physicalRemainingQty,
    broker_position_qty: brokerPositionQty,
    broker_sellable_qty: brokerSellableQty,
    position,
  };
}

export function arm_junk_experiment_unpriced_force_close({
  row,
  broker_order,
  positions = [],
  ownership_rows = [],
  now = new Date(),
} = {}) {
  const proof = prove_junk_experiment_unpriced_force_close_ownership({
    row,
    broker_order,
    positions,
    ownership_rows,
  });
  if (!proof.passed) return { armed: false, proof, row };
  if (row.experiment_ledger.entry_allocation_finalized !== true) {
    row.experiment_ledger = finalize_junk_experiment_unpriced_entry_allocation(
      row.experiment_ledger,
      { filled_qty: proof.broker_filled_qty, now },
    );
  } else {
    row.experiment_ledger = {
      ...row.experiment_ledger,
      entry_fill_avg_price: null,
      entry_fill_unpriced: true,
      ownership_status: 'force_close_unpriced',
      variants: Object.fromEntries(Object.entries(row.experiment_ledger.variants || {}).map(([lineId, variant]) => [
        lineId,
        {
          ...variant,
          allocated_entry_value: null,
          comparison_eligible: false,
          comparison_exclusion_reason: 'entry_fill_average_missing_force_close_unpriced',
          realized_pnl_usd: null,
        },
      ])),
      updated_at: now.toISOString(),
    };
  }
  row.filled_qty = proof.broker_filled_qty;
  row.entry_fill_price = null;
  row.entry_fill_price_source = null;
  row.entry_fill_unpriced = true;
  row.experiment_unpriced_force_close = true;
  row.status = 'open';
  row.last_error = 'experiment_entry_fill_average_missing_force_close_unpriced';
  row.updated_at = now.toISOString();
  return { armed: true, proof, row };
}

async function fetch_optional_order_fills(runtime, label) {
  try {
    return await with_timeout(
      fetchOrderFillList(runtime.client, runtime.config), 10_000, label,
    );
  } catch (error) {
    if (is_simulated_fill_history_unsupported(error, runtime.config?.trdEnv)) {
      return { s2c: { orderFillList: [] }, simulated_fill_history_unsupported: true };
    }
    throw error;
  }
}

export function is_simulated_fill_history_unsupported(error, trd_env) {
  if (Number(trd_env) !== TRD_ENV_SIMULATE) return false;
  const normalized = normalizeForJson(error);
  const message = String(error?.message || '');
  return (Number(normalized?.retType) === -1
      && String(normalized?.retMsg || '').includes('模拟交易不支持成交数据'))
    || /^GetOrderFillList failed: retType=-1\b.*模拟交易不支持成交数据/.test(message);
}

function expiration_from_option_code(code) {
  const match = String(code || '').toUpperCase().match(/^[A-Z.]+(\d{2})(\d{2})(\d{2})[CP]\d+$/);
  if (!match) return null;
  return `20${match[1]}-${match[2]}-${match[3]}`;
}

function entry_row_from_plan(plan, broker_order, now) {
  const signal = plan?.signal || {};
  const order = plan?.order || {};
  const contract = plan?.contract || {};
  const broker_identity = broker_order_identity(broker_order);
  const plan_identity = broker_order_identity(plan?.execution);
  const order_id = broker_identity.order_id || plan_identity.order_id;
  const order_id_ex = broker_identity.order_id_ex || plan_identity.order_id_ex;
  const recovery_id = order_id_ex || order_id;
  const fill = broker_fill_summary(broker_order);
  const plan_id = String(plan?.plan_id || `zero_dte_recovered_${recovery_id || randomUUID().replaceAll('-', '')}`).trim();
  const row = {
    plan_id: plan_id.startsWith('zero_dte_') ? plan_id : `zero_dte_${plan_id}`,
    signal_id: String(signal.signal_id || broker_remark(broker_order).slice('junk_gex:'.length) || `recovered_${recovery_id}`).trim(),
    status: fill.qty > 0 ? 'open' : 'entry_submitted',
    code: String(order.code || contract.code || broker_order?.code || '').trim(),
    contract_market: finite_number(contract.market, QOT_MARKET_US_SECURITY),
    expiration: String(contract.expiration || signal.expiration || expiration_from_option_code(order.code || broker_order?.code) || '').slice(0, 10),
    submitted_qty: finite_number(order.qty ?? broker_order?.qty, 0),
    filled_qty: fill.qty,
    exited_qty: 0,
    pending_exit_qty: 0,
    entry_limit_price: positive_number(order.price ?? broker_order?.price),
    entry_fill_price: fill.avg_price,
    entry_fill_price_source: fill.avg_price !== null ? 'broker_order_fill_average' : null,
    option_return_pct: null,
    peak_option_return_pct: null,
    breakeven_armed: false,
    entry_order_id: order_id,
    entry_order_id_ex: order_id_ex,
    entry_remark: broker_remark(broker_order) || String(order.remark || '').trim(),
    entry_submitted_at: plan?.execution?.submitted_at || plan?.planned_at || broker_order?.createTime || now.toISOString(),
    entry_filled_at: fill.qty > 0
      ? (broker_order?.updatedTime || broker_order?.createTime || now.toISOString())
      : null,
    setup_type: String(signal.node_reaction || signal.setup_type || '').trim().toLowerCase() || null,
    direction: String(signal.direction || '').trim().toLowerCase(),
    invalidation_price: positive_number(signal.invalidation_price),
    target_price: positive_number(signal.target_price),
    contract_multiplier: finite_number(plan?.position_sizing?.contract_multiplier, 100),
    recovered_from_broker: true,
    updated_at: now.toISOString(),
  };
  if (plan?.experiment?.cohort_id) {
    row.experiment_id = plan.experiment.experiment_id;
    row.cohort_id = plan.experiment.cohort_id;
    row.experiment_manifest_hash = plan.experiment.manifest_hash;
    row.experiment_ledger = create_junk_experiment_ledger(plan.experiment, now);
  }
  return row;
}

export function finalize_junk_experiment_entry_if_terminal(row, broker_order, now = new Date()) {
  if (!is_junk_experiment_row(row) || row.experiment_ledger.entry_allocation_finalized === true) {
    return { finalized: false, row };
  }
  if (!is_terminal_broker_order(broker_order?.orderStatus)) {
    return { finalized: false, row };
  }
  const filled_qty = Math.max(0, Math.floor(finite_number(row.filled_qty, 0)));
  if (filled_qty < 1) return { finalized: false, row };
  const fill_avg_price = positive_number(row.entry_fill_price);
  if (fill_avg_price === null) {
    return { finalized: false, row, reason: 'experiment_entry_fill_average_missing' };
  }
  row.experiment_ledger = finalize_junk_experiment_entry_allocation(row.experiment_ledger, {
    filled_qty,
    fill_avg_price,
    now,
  });
  row.experiment_entry_allocation_finalized_at = now.toISOString();
  row.updated_at = now.toISOString();
  return { finalized: true, row };
}

function daily_experiment_summary(state) {
  return summarize_junk_exit_experiment(state);
}

async function recover_line_ownership({ runtime, state, now, persist_state }) {
  const orders_response = await with_timeout(
    fetchOrderList(runtime.client, runtime.config), 10_000, 'recovery GetOrderList',
  );
  const fills_response = await fetch_optional_order_fills(runtime, 'recovery GetOrderFillList');
  const positions_response = await with_timeout(
    fetchPositionList(runtime.client, runtime.config), 10_000, 'recovery GetPositionList',
  );
  const plan_rows = await read_ndjson(entry_plans_path);
  const orders = broker_rows(orders_response, 'orderList');
  const fills = broker_rows(fills_response, 'orderFillList');
  const positions = broker_rows(positions_response, 'positionList');
  const fills_by_order = fill_identity_map(fills);
  const entry_orders = orders.filter((row) => broker_remark(row).startsWith('junk_gex:'));
  const exit_orders = orders.filter((row) => broker_remark(row).startsWith('junk_gex_exit:'));
  const plans = plan_rows.filter((row) => row?.business_line === ZERO_DTE_BUSINESS_LINE
    && [JUNK_GEX_STRATEGY, 'junk_gex_nodes_v2', 'junk_gex_nodes_v1'].includes(row?.strategy)
    && row?.order?.side === 'buy_to_open');
  const plan_for_order = (order) => {
    const order_keys = new Set(broker_order_keys(order));
    return [...plans].reverse().find((plan) => (
      broker_order_keys(plan?.execution).some((key) => order_keys.has(key))
        || String(plan?.order?.remark || '') === broker_remark(order)
    )) || null;
  };

  const state_rows = Object.values(state.orders || {});
  const referenced_entry_ids = new Set(state_rows.flatMap((row) => row_order_keys(row, 'entry')));
  const orphan_experiment_entry_failures = [];
  for (const order of entry_orders) {
    const order_keys = broker_order_keys(order);
    const id = broker_order_id(order);
    if (order_keys.some((key) => referenced_entry_ids.has(key))) continue;
    const matched_plan = plan_for_order(order);
    const orphan_experiment_entry = !matched_plan && broker_remark(order).startsWith('junk_gex:exp:');
    const plan = matched_plan || {
      plan_id: `zero_dte_recovered_${id || randomUUID().replaceAll('-', '')}`,
      signal: {
        signal_id: broker_remark(order).slice('junk_gex:'.length),
        expiration: expiration_from_option_code(order?.code),
      },
      contract: { code: order?.code, market: QOT_MARKET_US_SECURITY },
      order: { code: order?.code, qty: order?.qty, price: order?.price, remark: broker_remark(order) },
    };
    const recovered = entry_row_from_plan(plan, order, now);
    if (orphan_experiment_entry) {
      recovered.status = 'recovery_blocked';
      recovered.last_error = 'experiment_entry_plan_missing_virtual_ownership_recovery_blocked';
      recovered.orphan_experiment_entry = true;
      orphan_experiment_entry_failures.push({
        plan_id: recovered.plan_id,
        code: recovered.code,
        order_id: recovered.entry_order_id,
        order_id_ex: recovered.entry_order_id_ex,
        remark: recovered.entry_remark,
      });
    }
    state.orders[recovered.plan_id] = recovered;
    for (const key of order_keys) referenced_entry_ids.add(key);
  }
  for (const row of Object.values(state.orders || {})) {
    if (row?.orphan_experiment_entry !== true) continue;
    if (orphan_experiment_entry_failures.some((failure) => failure.plan_id === row.plan_id)) continue;
    orphan_experiment_entry_failures.push({
      plan_id: row.plan_id,
      code: row.code,
      order_id: row.entry_order_id || null,
      order_id_ex: row.entry_order_id_ex || null,
      remark: row.entry_remark || null,
    });
  }

  const orders_by_id = identity_map(orders);
  const positions_by_code = new Map(positions
    .filter((row) => row?.code)
    .map((row) => [String(row.code), row]));
  let recovered_order_count = 0;
  const experiment_fill_recovery_failures = [];
  const experiment_entry_price_failures = [];
  for (const row of Object.values(state.orders || {})) {
    const recovery_start_status = String(row.status || '');
    const tracked_exit_at_start = Boolean(row.exit_remark) || row_has_order_identity(row, 'exit');
    const expected_entry_remark = row.entry_remark || `junk_gex:${row.signal_id}`.slice(0, 60);
    let entry_order = find_by_row_identity(orders_by_id, row, 'entry')
      || entry_orders.find((order) => broker_remark(order) === expected_entry_remark)
      || null;
    if (entry_order) apply_broker_order_identity(row, 'entry', entry_order);
    if (entry_order) {
      const entry_fills = fills_for_identity(fills_by_order, entry_order);
      const fill = is_junk_experiment_row(row)
        ? resolve_junk_experiment_entry_fill({
          row,
          broker_order: entry_order,
          fills: entry_fills,
          positions,
          ownership_rows: Object.values(state.orders || {}),
        })
        : broker_fill_summary(entry_order, entry_fills);
      row.filled_qty = Math.max(finite_number(row.filled_qty, 0), fill.qty);
      if (fill.avg_price !== null) {
        row.entry_fill_price = fill.avg_price;
        if (is_junk_experiment_row(row)) row.entry_fill_price_source = fill.source;
      } else if (!is_junk_experiment_row(row)) {
        row.entry_fill_price = positive_number(row.entry_fill_price);
      }
      row.entry_remark = broker_remark(entry_order) || expected_entry_remark;
      if (row.filled_qty <= 0 && is_terminal_unfilled_broker_order(entry_order.orderStatus)) {
        row.status = Number(entry_order.orderStatus) === 3 ? 'submit_failed' : 'entry_unfilled_terminal';
      } else if (row.filled_qty > 0 && !tracked_exit_at_start) {
        row.status = row_has_order_identity(row, 'exit') ? 'exit_submitted' : 'open';
      }
      if (is_junk_experiment_row(row) && row.filled_qty > 0 && positive_number(row.entry_fill_price) === null) {
        row.status = 'recovery_blocked';
        row.last_error = 'experiment_entry_fill_average_missing_recovery_blocked';
        row.experiment_ledger.ownership_status = 'recovery_blocked';
        experiment_entry_price_failures.push({
          plan_id: row.plan_id,
          cohort_id: row.experiment_ledger.cohort_id,
          code: row.code,
          filled_qty: row.filled_qty,
          reason: row.last_error,
        });
      } else {
        finalize_junk_experiment_entry_if_terminal(row, entry_order, now);
      }
      recovered_order_count += 1;
    }
    if (row.orphan_experiment_entry === true) {
      row.status = 'recovery_blocked';
      row.last_error = 'experiment_entry_plan_missing_virtual_ownership_recovery_blocked';
      row.updated_at = now.toISOString();
      continue;
    }

    const expected_exit_remark = row.exit_remark || exit_remark_base(row);
    const current_exit_keys = new Set(row_order_keys(row, 'exit'));
    const current_attempt_orders = exit_orders.filter((order) => (
      (row.exit_remark && broker_remark(order) === row.exit_remark)
      || broker_order_keys(order).some((key) => current_exit_keys.has(key))
    ));
    const matching_exits = exit_orders.filter((order) => (
      broker_remark(order) === expected_exit_remark
      || broker_remark(order) === exit_remark_base(row)
      || broker_remark(order).startsWith(`${exit_remark_base(row)}:`)
      || broker_order_keys(order).some((key) => row_order_keys(row, 'exit').includes(key))
    ));
    row.exit_attempt_no = Math.max(
      Math.trunc(finite_number(row.exit_attempt_no, 0)),
      observed_exit_attempt_no(row.plan_id, matching_exits),
    );
    let total_exit_qty = 0;
    let total_exit_value = 0;
    for (const exit_order of matching_exits) {
      const fill = broker_fill_summary(exit_order, fills_for_identity(fills_by_order, exit_order));
      total_exit_qty += fill.qty;
      total_exit_value += fill.value || 0;
    }
    if (!is_junk_experiment_row(row)) {
      row.exited_qty = Math.min(finite_number(row.filled_qty, 0), Math.max(finite_number(row.exited_qty, 0), total_exit_qty));
      if (total_exit_value > 0) row.exit_fill_value = Number(total_exit_value.toFixed(8));
    }
    const active_current_exit = [...current_attempt_orders].reverse()
      .find((order) => !is_terminal_broker_order(order.orderStatus)) || null;
    const active_historical_exit = [...matching_exits].reverse()
      .find((order) => !is_terminal_broker_order(order.orderStatus)) || null;
    const unresolved_current_exit = unresolved_exit_recovery_required(
      { ...row, status: recovery_start_status },
      current_attempt_orders,
    );
    const active_exit = active_current_exit || (unresolved_current_exit ? null : active_historical_exit);
    let experiment_fill_recovery_error = null;
    if (is_junk_experiment_row(row) && row.experiment_ledger.pending_exit_batch && current_attempt_orders.length > 0) {
      const current_attempt = current_attempt_orders.at(-1);
      const current_fill = broker_fill_summary(
        current_attempt,
        fills_for_identity(fills_by_order, current_attempt),
      );
      const accounted_qty = finite_number(row.experiment_ledger.pending_exit_batch.accounted_fill_qty, 0);
      if (current_fill.qty > 0 && positive_number(current_fill.avg_price) === null) {
        experiment_fill_recovery_error = 'experiment_positive_exit_fill_missing_average_price';
      } else if (current_fill.qty < accounted_qty) {
        experiment_fill_recovery_error = `experiment_broker_cumulative_fill_regressed:${current_fill.qty}:${accounted_qty}`;
      } else {
        const recovered_allocation = apply_junk_experiment_exit_cumulative_fill(row.experiment_ledger, {
          cumulative_fill_qty: current_fill.qty,
          cumulative_fill_avg_price: current_fill.avg_price,
          terminal: is_terminal_broker_order(current_attempt.orderStatus),
          now,
        });
        row.experiment_ledger = recovered_allocation.ledger;
        apply_experiment_filled_management(
          row,
          recovered_allocation.deltas,
          is_terminal_broker_order(current_attempt.orderStatus),
        );
      }
    }
    if (is_junk_experiment_row(row)) {
      // The virtual ledger above must consume the broker cumulative fill before
      // the physical aggregate row is advanced during restart recovery.
      if (row.experiment_ledger.entry_allocation_finalized === true && !experiment_fill_recovery_error) {
        row.exited_qty = Math.max(0, finite_number(row.filled_qty, 0)
          - experiment_total_remaining_qty(row.experiment_ledger));
        row.exit_fill_value = Number((Object.values(row.experiment_ledger.variants || {})
          .reduce((sum, variant) => sum + finite_number(variant.allocated_exit_value, 0), 0)
          + finite_number(row.experiment_ledger.unallocated_exit_value, 0)).toFixed(8));
      }
      if (experiment_fill_recovery_error) {
        row.status = 'recovery_blocked';
        row.last_error = experiment_fill_recovery_error;
        row.experiment_ledger.ownership_status = 'recovery_blocked';
        row.updated_at = now.toISOString();
        experiment_fill_recovery_failures.push({
          plan_id: row.plan_id,
          cohort_id: row.experiment_ledger.cohort_id,
          reason: experiment_fill_recovery_error,
        });
        continue;
      }
      if (active_exit && !row.experiment_ledger.pending_exit_batch) {
        row.status = 'recovery_blocked';
        row.last_error = 'experiment_active_exit_missing_pending_allocation_batch';
        row.experiment_ledger.ownership_status = 'recovery_blocked';
        row.updated_at = now.toISOString();
        experiment_fill_recovery_failures.push({
          plan_id: row.plan_id,
          cohort_id: row.experiment_ledger.cohort_id,
          reason: row.last_error,
        });
        continue;
      }
    }
    if (active_exit) {
      const active_fill = broker_fill_summary(active_exit, fills_for_identity(fills_by_order, active_exit));
      if (is_junk_experiment_row(row)) {
        row.exit_base_exited_qty = Math.max(0, finite_number(row.exited_qty, 0) - active_fill.qty);
        row.exit_order_accounted_fill_qty = active_fill.qty;
        row.exit_order_accounted_fill_value = finite_number(active_fill.value, 0);
      } else {
        seed_recovered_active_exit_accounting(row, total_exit_qty, total_exit_value, active_fill);
      }
      apply_broker_order_identity(row, 'exit', active_exit);
      row.exit_remark = broker_remark(active_exit);
      row.pending_exit_qty = Math.max(0, finite_number(active_exit.qty, 0) - finite_number(active_exit.fillQty, 0));
      row.status = 'exit_submitted';
      row.last_error = null;
    } else if (unresolved_current_exit) {
      row.status = recovery_start_status === 'exit_intent' ? 'exit_submission_unknown' : recovery_start_status;
      row.last_error = 'exit_submission_outcome_unknown_recovery_blocked';
    } else if (row.exited_qty >= finite_number(row.filled_qty, 0) && row.exited_qty > 0) {
      row.status = 'closed';
      row.pending_exit_qty = 0;
      row.exit_order_id = null;
      row.exit_order_id_ex = null;
    } else if (row.filled_qty > 0) {
      row.status = 'open';
      row.pending_exit_qty = 0;
      row.exit_order_id = null;
      row.exit_order_id_ex = null;
      row.exit_remark = null;
    }
    const position = positions_by_code.get(String(row.code || '')) || null;
    if (position) {
      row.position_id = position.positionID || position.positionId || row.position_id || null;
      row.broker_position_qty = finite_number(position.qty);
      row.broker_can_sell_qty = finite_number(position.canSellQty);
    }
    const current_session_date = ny_context(now).date_key;
    if (!entry_order
      && ['entry_intent', 'entry_submission_unknown', 'entry_submitted', 'recovery_blocked']
        .includes(recovery_start_status)
      && expired_entry_without_broker_evidence(row, position, current_session_date)) {
      row.status = 'expired_no_submission_evidence';
      row.pending_exit_qty = 0;
      row.last_error = 'expired_entry_has_no_broker_order_fill_or_position_evidence';
    } else if (expired_settlement_missing(row, position, current_session_date)) {
      row.status = 'expired_settled_unpriced';
      row.pending_exit_qty = 0;
      row.exit_order_id = null;
      row.exit_order_id_ex = null;
      row.last_error = 'expired_contract_absent_from_broker_positions_requires_settlement_reconciliation';
    }
    if (row.status === 'closed' && positive_number(row.entry_fill_price) !== null && row.exited_qty > 0) {
      const weighted_exit = finite_number(row.exit_fill_value, 0) / row.exited_qty;
      row.weighted_exit_fill_price = Number(weighted_exit.toFixed(6));
      row.realized_pnl_usd = Number(((weighted_exit - row.entry_fill_price)
        * row.exited_qty * positive_number(row.contract_multiplier, 100)).toFixed(2));
    }
    row.updated_at = now.toISOString();
  }

  recompute_session_risk(state);
  const recovery_source = state.broker_recovery?.source_state || 'unknown';
  const active_line_codes = new Set(Object.values(state.orders || {})
    .filter((row) => !terminal_order_state(row.status)
      && finite_number(row.filled_qty, 0) > finite_number(row.exited_qty, 0)
      && row.code)
    .map((row) => String(row.code)));
  const unowned_broker_positions = positions.filter((position) => (
    finite_number(position?.qty, 0) > 0
      && !active_line_codes.has(String(position?.code || ''))
  ));
  const ambiguous_new_or_corrupt_state = untrusted_state_requires_recovery_block(
    recovery_source,
    unowned_broker_positions.length,
  );
  const experiment_ownership_failures = [];
  for (const row of Object.values(state.orders || {})) {
    if (!is_junk_experiment_row(row) || row.experiment_ledger.entry_allocation_finalized !== true) continue;
    if (terminal_order_state(row.status) && experiment_total_remaining_qty(row.experiment_ledger) === 0) continue;
    const position = positions_by_code.get(String(row.code || '')) || null;
    const invariant = junk_experiment_ownership_invariant(row, position);
    if (!invariant.passed) {
      row.status = 'recovery_blocked';
      row.last_error = invariant.reasons.join(',');
      row.experiment_ledger.ownership_status = 'recovery_blocked';
      experiment_ownership_failures.push({ plan_id: row.plan_id, ...invariant });
    }
  }
  const experiment_ownership_blocked = experiment_ownership_failures.length > 0;
  const experiment_fill_blocked = experiment_fill_recovery_failures.length > 0;
  const experiment_entry_price_blocked = experiment_entry_price_failures.length > 0;
  const orphan_experiment_entry_blocked = orphan_experiment_entry_failures.length > 0;
  state.broker_recovery = {
    status: ambiguous_new_or_corrupt_state
      || experiment_ownership_blocked
      || experiment_fill_blocked
      || experiment_entry_price_blocked
      || orphan_experiment_entry_blocked
      ? 'blocked'
      : 'complete',
    checked_at: now.toISOString(),
    recovered_order_count,
    source_state: recovery_source,
    unowned_broker_position_count: unowned_broker_positions.length,
    error_code: ambiguous_new_or_corrupt_state
      ? 'unowned_simulated_option_positions_with_untrusted_local_state'
      : (orphan_experiment_entry_blocked
        ? 'experiment_entry_plan_missing_virtual_ownership'
        : (experiment_entry_price_blocked
          ? 'experiment_entry_fill_average_missing'
          : (experiment_fill_blocked
        ? 'experiment_exit_fill_reconciliation_blocked'
        : (experiment_ownership_blocked ? 'experiment_broker_ledger_qty_mismatch' : null)))),
    experiment_ownership_failures,
    experiment_fill_recovery_failures,
    experiment_entry_price_failures,
    orphan_experiment_entry_failures,
  };
  await persist_state();
  return state.broker_recovery;
}

export function is_terminal_broker_order(status) {
  return [3, 11, 14, 15, 21, 22, 23, 24].includes(Number(status));
}

export function is_terminal_unfilled_broker_order(status) {
  return [3, 14, 15, 21, 22, 23, 24].includes(Number(status));
}

export function live_entry_remainder_pending(row, broker_order) {
  const filled_qty = finite_number(row?.filled_qty, 0);
  const submitted_qty = finite_number(row?.submitted_qty, 0);
  return filled_qty > 0
    && filled_qty < submitted_qty
    && !is_terminal_broker_order(broker_order?.orderStatus);
}

export function expired_settlement_missing(row, broker_position, current_session_date) {
  return (!broker_position || finite_number(broker_position.qty, 0) <= 0)
    && /^\d{4}-\d{2}-\d{2}$/.test(String(row?.expiration || ''))
    && row.expiration < String(current_session_date || '')
    && finite_number(row?.filled_qty, 0) > finite_number(row?.exited_qty, 0);
}

export function expired_entry_without_broker_evidence(row, broker_position, current_session_date) {
  return (!broker_position || finite_number(broker_position.qty, 0) <= 0)
    && /^\d{4}-\d{2}-\d{2}$/.test(String(row?.expiration || ''))
    && row.expiration < String(current_session_date || '')
    && finite_number(row?.filled_qty, 0) <= 0;
}

export function untrusted_state_requires_recovery_block(source_state, unowned_position_count) {
  return ['new', 'backup', 'corrupt_fail_closed'].includes(String(source_state || ''))
    && finite_number(unowned_position_count, 0) > 0;
}

export function provider_backoff_cycle_delay(poll_ms, blocked_ms) {
  const cadence = Math.max(1000, finite_number(poll_ms, 15_000));
  const remaining = Math.max(0, finite_number(blocked_ms, 0));
  return Math.max(1000, Math.min(cadence, remaining || cadence));
}

function risk_state(state) {
  return {
    executed_signal_ids: state.executed_signal_ids || [],
    open_position_count: open_position_count(state),
    daily_trade_count: finite_number(state.daily_trade_count, 0),
    daily_realized_pnl_usd: finite_number(state.daily_realized_pnl_usd, 0),
    last_entry_at: state.last_entry_at || null,
  };
}

export function recompute_session_risk(state) {
  const session_rows = Object.values(state.orders || {})
    .filter((row) => row.expiration === state.session_date_et);
  const accepted_rows = session_rows.filter((row) => row_has_order_identity(row, 'entry'));
  state.daily_trade_count = new Set(accepted_rows.map((row) => row_order_keys(row, 'entry')[0])).size;
  const submitted_times = accepted_rows
    .map((row) => row.entry_submitted_at)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  state.last_entry_at = submitted_times.at(-1) || null;
  state.daily_realized_pnl_usd = Number(session_rows
    .filter((row) => row.status === 'closed')
    .reduce((sum, row) => sum + finite_number(row.realized_pnl_usd, 0), 0)
    .toFixed(2));
  state.executed_signal_ids = [...new Set([
    ...(state.executed_signal_ids || []),
    ...session_rows.map((row) => row.signal_id).filter(Boolean),
  ])].slice(-1000);
  return risk_state(state);
}

export function fresh_last_gex_spot(state, now = new Date(), max_age_ms = 30_000) {
  const resolved_now = now instanceof Date ? now : new Date(now);
  const snapshot_at_ms = Date.parse(state?.last_gex?.snapshot_at || '');
  const age_ms = resolved_now.getTime() - snapshot_at_ms;
  const current_session = ny_context(resolved_now).date_key;
  if (String(state?.last_gex?.state || '').toLowerCase() !== 'fresh'
    || state?.last_gex?.session_date_et !== current_session
    || !Number.isFinite(age_ms) || age_ms < 0 || age_ms > max_age_ms) return null;
  return positive_number(state?.last_gex?.spot_usd);
}

async function broker_contract_conflict(runtime, code) {
  const contract_code = String(code || '').trim();
  if (!contract_code) return { conflict: true, reasons: ['missing_contract_code'] };
  const positions_response = await with_timeout(
    fetchPositionList(runtime.client, runtime.config), 10_000, 'contract conflict GetPositionList',
  );
  const orders_response = await with_timeout(
    fetchOrderList(runtime.client, runtime.config), 10_000, 'contract conflict GetOrderList',
  );
  const positions = broker_rows(positions_response, 'positionList')
    .filter((row) => String(row?.code || '') === contract_code && finite_number(row?.qty, 0) > 0);
  const pending_orders = broker_rows(orders_response, 'orderList')
    .filter((row) => String(row?.code || '') === contract_code && !is_terminal_broker_order(row?.orderStatus));
  const reasons = [];
  if (positions.length > 0) reasons.push('broker_contract_position_already_exists');
  if (pending_orders.length > 0) reasons.push('broker_contract_order_already_pending');
  return { conflict: reasons.length > 0, reasons };
}

function safe_config(args) {
  const loaded = loadMoomooConfig(moomooConfigOptionsForBusinessLine(business_line, args));
  const config = {
    ...loaded,
    businessLine: ZERO_DTE_BUSINESS_LINE,
    trdEnv: TRD_ENV_SIMULATE,
    allowRealTrading: false,
    policyExecutionEnvironment: 'simulate_only',
    policyRealTradingAllowed: false,
  };
  assertZeroDteSimulationOnly(config);
  const paper_equity_usd = positive_number(config.policy?.position_sizing?.paper_equity_usd);
  if (paper_equity_usd !== 10_000) {
    throw new Error('JUNKMAN paper_equity_usd must remain exactly 10000.');
  }
  return config;
}

async function create_moomoo_runtime(args) {
  const config = safe_config(args);
  const connection = await connectMoomoo(config);
  try {
    const accounts = await fetchMoomooAccounts(connection.client);
    const simulated_account = selectSimulatedUsOptionAccount(accounts);
    if (!simulated_account) throw new Error('No simulated US options account is available in OpenD.');
    const execution_config = {
      ...config,
      trdEnv: TRD_ENV_SIMULATE,
      accId: String(simulated_account.accID || ''),
    };
    const quote_feed = createMoomooQuoteFeed(connection.client, execution_config);
    return {
      client: connection.client,
      close: async () => {
        await quote_feed.close?.();
        connection.close();
      },
      quote_feed,
      config: execution_config,
      simulated_account: {
        acc_id: maskId(simulated_account.accID),
        trd_env: Number(simulated_account.trdEnv),
        sim_acc_type: Number(simulated_account.simAccType),
      },
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}

async function write_trade_event(event, payload = {}) {
  await append_json_line(trades_path, {
    event_at: new Date().toISOString(),
    event,
    business_line: ZERO_DTE_BUSINESS_LINE,
    strategy: JUNK_GEX_STRATEGY,
    strategy_label: 'JUNKMAN',
    execution_environment: 'simulate_only',
    ...payload,
  });
}

export function exit_owned_position(row) {
  return {
    business_line: ZERO_DTE_BUSINESS_LINE,
    strategy: JUNK_GEX_STRATEGY,
    plan_id: row.plan_id,
    code: row.code,
    expiration: row.expiration,
    filled_qty: finite_number(row.filled_qty, 0),
    exited_qty: finite_number(row.exited_qty, 0),
    pending_exit_qty: finite_number(row.pending_exit_qty, 0),
    entry_fill_price: positive_number(row.entry_fill_price),
    peak_option_return_pct: finite_number(row.peak_option_return_pct),
    breakeven_armed: row.breakeven_armed === true,
    position_id: row.position_id || null,
    direction: row.direction,
    invalidation_price: positive_number(row.invalidation_price),
    target_price: positive_number(row.target_price),
  };
}

export function apply_exit_management_update(row, management_update) {
  const was_breakeven_armed = row?.breakeven_armed === true;
  const previous_peak = finite_number(row?.peak_option_return_pct);
  const observed_peak = finite_number(management_update?.peak_option_return_pct);
  const peak_option_return_pct = previous_peak === null
    ? observed_peak
    : (observed_peak === null ? previous_peak : Math.max(previous_peak, observed_peak));
  const breakeven_armed = was_breakeven_armed || management_update?.breakeven_armed === true;

  row.option_return_pct = finite_number(management_update?.option_return_pct);
  row.peak_option_return_pct = peak_option_return_pct;
  row.breakeven_armed = breakeven_armed;
  return {
    option_return_pct: row.option_return_pct,
    peak_option_return_pct,
    breakeven_armed,
    newly_armed: !was_breakeven_armed && breakeven_armed,
  };
}

async function cancel_entry_if_needed(runtime, row, broker_order, now, reason, persist_state) {
  if (row.entry_cancel_requested_at) return false;
  try {
    await cancelOrder(runtime.client, runtime.config, {
      orderID: broker_order_identity(broker_order).order_id || row.entry_order_id,
      orderIDEx: row.entry_order_id_ex,
    });
    row.entry_cancel_requested_at = now.toISOString();
    row.entry_cancel_reason = reason;
    row.updated_at = now.toISOString();
    await persist_state();
    await write_trade_event('entry_order_cancel_requested', {
      plan_id: row.plan_id,
      signal_id: row.signal_id,
      code: row.code,
      order_id: row.entry_order_id,
      order_id_ex: row.entry_order_id_ex,
      reason,
    });
    return true;
  } catch (error) {
    row.last_error = sanitized_error(error);
    row.updated_at = now.toISOString();
    await persist_state();
    return false;
  }
}

export function apply_exit_cumulative_fill(row, exit_fill) {
  const exit_filled_qty = finite_number(exit_fill?.qty, 0);
  const exit_cumulative_value = finite_number(
    exit_fill?.value,
    positive_number(exit_fill?.avg_price) === null ? 0 : exit_filled_qty * exit_fill.avg_price,
  );
  const base_exited_qty = finite_number(row.exit_base_exited_qty, finite_number(row.exited_qty, 0));
  const previous_exited_qty = finite_number(row.exited_qty, 0);
  const prior_order_value = finite_number(row.exit_order_accounted_fill_value, 0);
  row.exited_qty = Math.min(finite_number(row.filled_qty, 0), base_exited_qty + exit_filled_qty);
  row.exit_fill_price = positive_number(exit_fill?.avg_price, positive_number(row.exit_submitted_price));
  if (exit_cumulative_value > prior_order_value) {
    row.exit_fill_value = Number((finite_number(row.exit_fill_value, 0)
      + exit_cumulative_value - prior_order_value).toFixed(8));
  }
  row.exit_order_accounted_fill_qty = exit_filled_qty;
  row.exit_order_accounted_fill_value = Number(exit_cumulative_value.toFixed(8));
  return {
    previous_exited_qty,
    exited_qty: row.exited_qty,
    exit_fill_value: row.exit_fill_value,
  };
}

export function block_unresolved_submission(row, kind, now = new Date()) {
  const prefix = kind === 'exit' ? 'exit' : 'entry';
  row[`${prefix}_order_missing_cycles`] = finite_number(row[`${prefix}_order_missing_cycles`], 0) + 1;
  row.last_error = `${prefix}_submission_outcome_unknown_recovery_blocked`;
  row.updated_at = now.toISOString();
  return row;
}

function experiment_variant_owned_position(row, variant) {
  return {
    business_line: ZERO_DTE_BUSINESS_LINE,
    strategy: JUNK_GEX_STRATEGY,
    plan_id: `${row.plan_id}:${variant.line_id}`,
    experiment_id: row.experiment_ledger.experiment_id,
    cohort_id: row.experiment_ledger.cohort_id,
    experiment_line_ids: [variant.line_id],
    code: row.code,
    expiration: row.expiration,
    filled_qty: finite_number(variant.allocated_entry_qty, 0),
    exited_qty: finite_number(variant.allocated_exit_qty, 0),
    pending_exit_qty: 0,
    entry_fill_price: positive_number(row.experiment_ledger.entry_fill_avg_price, positive_number(row.entry_fill_price)),
    entry_at: row.entry_filled_at || row.entry_submitted_at || null,
    setup_type: row.setup_type || null,
    peak_option_return_pct: finite_number(variant.peak_option_return_pct),
    breakeven_armed: variant.breakeven_armed === true,
    partial_target_taken: variant.partial_target_taken === true,
    management_floor_pct: finite_number(variant.management_floor_pct),
    position_id: row.position_id || null,
    direction: row.direction,
    invalidation_price: positive_number(row.invalidation_price),
    target_price: positive_number(row.target_price),
  };
}

function experiment_full_exit_reason(plan) {
  if (!plan?.gate?.passed || !plan?.order) return null;
  if (plan.trigger?.structural_target_exit === 'partial') return null;
  return plan.trigger?.reason || 'variant_full_exit_trigger';
}

export function advance_junk_experiment_exit_latch(current_latch, variant_plan, remaining_qty) {
  const remaining = Math.max(0, Math.floor(finite_number(remaining_qty, 0)));
  if (remaining < 1) return null;
  const full_reason = experiment_full_exit_reason(variant_plan);
  if (current_latch?.kind === 'full') {
    return { ...current_latch, remaining_qty: remaining };
  }
  if (full_reason) {
    return {
      kind: 'full',
      reason: full_reason,
      remaining_qty: remaining,
      management_update: variant_plan.management_update || {},
    };
  }
  if (current_latch) return current_latch;
  if (!variant_plan?.gate?.passed || !variant_plan?.order) return null;
  const planned_requested_qty = Math.min(
    remaining,
    Math.max(0, Math.floor(finite_number(variant_plan.order.qty, 0))),
  );
  if (planned_requested_qty < 1) return null;
  return {
    kind: 'structural_partial',
    reason: variant_plan.trigger?.reason || 'structural_target_partial',
    remaining_qty: planned_requested_qty,
    management_update: variant_plan.management_update || {},
  };
}

function experiment_exit_latch(row, line_id) {
  return row?.experiment_exit_latches?.[line_id] || null;
}

function set_experiment_exit_latch(row, line_id, latch) {
  row.experiment_exit_latches = { ...(row.experiment_exit_latches || {}) };
  row.experiment_exit_latches[line_id] = latch;
}

function clear_experiment_exit_latch(row, line_id) {
  if (!row.experiment_exit_latches?.[line_id]) return;
  row.experiment_exit_latches = { ...row.experiment_exit_latches };
  delete row.experiment_exit_latches[line_id];
  if (Object.keys(row.experiment_exit_latches).length === 0) row.experiment_exit_latches = null;
}

function experiment_exit_attempt_remark(row, attempt_no) {
  return `junk_gex_exit:exp:${String(row.experiment_ledger.cohort_id).slice(-16)}:${attempt_no}`.slice(0, 60);
}

function reset_experiment_exit_attempt(row, now) {
  row.status = 'open';
  row.exit_order_id = null;
  row.exit_order_id_ex = null;
  row.exit_remark = null;
  row.pending_exit_qty = 0;
  row.exit_base_exited_qty = finite_number(row.exited_qty, 0);
  row.exit_order_accounted_fill_qty = 0;
  row.exit_order_accounted_fill_value = 0;
  row.exit_cancel_requested_at = null;
  row.experiment_exit_management_by_line = null;
  row.experiment_exit_requested_by_line = null;
  row.updated_at = now.toISOString();
}

export function apply_experiment_filled_management(row, deltas, terminal = false) {
  for (const delta of deltas || []) {
    if (!delta.line_id || delta.qty < 1) continue;
    const latch = experiment_exit_latch(row, delta.line_id);
    if (!latch) continue;
    const remaining_qty = Math.max(0, Math.floor(finite_number(latch.remaining_qty, 0)) - delta.qty);
    const variant_remaining_qty = experiment_variant_remaining_qty(
      row.experiment_ledger.variants?.[delta.line_id],
    );
    if (latch.kind === 'structural_partial' && remaining_qty === 0) {
      row.experiment_ledger = update_junk_experiment_variant_management(
        row.experiment_ledger,
        delta.line_id,
        latch.management_update || {},
      );
    }
    if (remaining_qty === 0 || (latch.kind === 'full' && variant_remaining_qty === 0)) {
      clear_experiment_exit_latch(row, delta.line_id);
    } else {
      set_experiment_exit_latch(row, delta.line_id, { ...latch, remaining_qty, has_fill: true });
    }
  }
  if (terminal) {
    for (const [line_id, latch] of Object.entries(row.experiment_exit_latches || {})) {
      if (latch.kind === 'structural_partial' && latch.has_fill !== true) {
        clear_experiment_exit_latch(row, line_id);
      }
    }
    row.experiment_exit_management_by_line = null;
    row.experiment_exit_requested_by_line = null;
  }
}

async function reconcile_junk_experiment_row({
  runtime,
  state,
  row,
  now,
  underlying_price_usd,
  allow_execution,
  persist_state,
  exit_config,
  force_close,
  emergency_submission_allowed,
  session_date_et,
  position,
  orders,
  order_rows,
  fills_by_order,
  option_snapshot,
}) {
  const fields = experiment_event_fields(row, {
    plan_id: row.plan_id,
    signal_id: row.signal_id,
    code: row.code,
  });
  let exit_order = find_by_row_identity(orders, row, 'exit')
    || (row.exit_remark
      ? order_rows.find((order) => broker_remark(order) === row.exit_remark)
      : null)
    || null;
  if (!exit_order && row_has_order_identity(row, 'exit')) {
    const recovered_fill = broker_fill_summary(null, fills_for_identity(fills_by_order, {
      order_id: row.exit_order_id,
      order_id_ex: row.exit_order_id_ex,
    }));
    if (recovered_fill.qty > 0) {
      exit_order = {
        orderID: row.exit_order_id,
        orderIDEx: row.exit_order_id_ex,
        orderStatus: 4,
        fillQty: recovered_fill.qty,
        fillAvgPrice: recovered_fill.avg_price,
        remark: row.exit_remark,
      };
    }
  }
  if (exit_order) apply_broker_order_identity(row, 'exit', exit_order);

  if (!exit_order && ['exit_intent', 'exit_submission_unknown'].includes(row.status)) {
    block_unresolved_submission(row, 'exit', now);
    row.experiment_ledger.ownership_status = 'recovery_blocked';
    await persist_state();
    return { submitted: false, blocked: true };
  }
  if (row_has_order_identity(row, 'exit')) {
    if (!exit_order || !row.experiment_ledger.pending_exit_batch) {
      row.status = 'recovery_blocked';
      row.last_error = !exit_order
        ? 'experiment_exit_order_missing_from_broker_recovery_required'
        : 'experiment_exit_allocation_batch_missing_recovery_blocked';
      row.experiment_ledger.ownership_status = 'recovery_blocked';
      row.updated_at = now.toISOString();
      await persist_state();
      await write_experiment_event('experiment_recovery_blocked', row, { reason: row.last_error });
      return { submitted: false, blocked: true };
    }
    const exit_fill = broker_fill_summary(exit_order, fills_for_identity(fills_by_order, exit_order));
    const terminal = is_terminal_broker_order(exit_order.orderStatus);
    const accounted_fill_qty = Math.max(
      0,
      Math.floor(finite_number(row.experiment_ledger.pending_exit_batch?.accounted_fill_qty, 0)),
    );
    if ((exit_fill.qty > 0 && positive_number(exit_fill.avg_price) === null)
      || exit_fill.qty < accounted_fill_qty) {
      row.status = 'recovery_blocked';
      row.last_error = exit_fill.qty < accounted_fill_qty
        ? `experiment_broker_cumulative_fill_regressed:${exit_fill.qty}:${accounted_fill_qty}`
        : 'experiment_positive_exit_fill_missing_average_price';
      row.experiment_ledger.ownership_status = 'recovery_blocked';
      state.broker_recovery = {
        ...(state.broker_recovery || {}),
        status: 'blocked',
        checked_at: now.toISOString(),
        error_code: 'experiment_exit_fill_reconciliation_blocked',
      };
      await persist_state();
      await write_experiment_event('experiment_exit_fill_reconciliation_blocked', row, {
        reason: row.last_error,
        broker_cumulative_fill_qty: exit_fill.qty,
        accounted_fill_qty,
      });
      return { submitted: false, blocked: true };
    }
    // Virtual ownership is accounted first. The physical row is updated only
    // after the deterministic cumulative allocation has been persisted.
    const allocation = apply_junk_experiment_exit_cumulative_fill(row.experiment_ledger, {
      cumulative_fill_qty: exit_fill.qty,
      cumulative_fill_avg_price: exit_fill.avg_price,
      terminal,
      now,
    });
    const variants_before_fill = row.experiment_ledger.variants || {};
    const reason_by_line = row.experiment_ledger.pending_exit_batch?.reason_by_line || {};
    row.experiment_ledger = allocation.ledger;
    apply_experiment_filled_management(row, allocation.deltas, terminal);
    await persist_state();
    for (const delta of allocation.deltas) {
      await write_experiment_event('experiment_exit_fill_allocated', row, {
        line_id: delta.line_id,
        allocation_key: delta.allocation_key,
        qty: delta.qty,
        value: delta.value,
        cumulative_qty: delta.cumulative_qty,
        cumulative_value: delta.cumulative_value,
        exit_order_id: row.exit_order_id,
        exit_order_id_ex: row.exit_order_id_ex,
      });
      await write_trade_event('experiment_line_exit_fill_progress', {
        ...fields,
        line_id: delta.line_id,
        allocation_key: delta.allocation_key,
        qty: delta.qty,
        value: delta.value,
      });
      if (delta.line_id) {
        const before = variants_before_fill[delta.line_id];
        const after = row.experiment_ledger.variants?.[delta.line_id];
        if (before?.status !== 'closed' && after?.status === 'closed') {
          const closed_payload = {
            line_id: delta.line_id,
            entry_qty: after.allocated_entry_qty,
            entry_value: after.allocated_entry_value,
            exit_qty: after.allocated_exit_qty,
            exit_value: after.allocated_exit_value,
            realized_pnl_usd: after.realized_pnl_usd,
            trigger_reason: reason_by_line[delta.line_id] || null,
            exit_profile_hash: after.exit_profile_hash,
          };
          await write_experiment_event('experiment_line_position_closed', row, closed_payload);
          await write_trade_event('experiment_line_position_closed', {
            ...fields,
            ...closed_payload,
          });
        }
      }
    }
    const { previous_exited_qty } = apply_exit_cumulative_fill(row, exit_fill);
    row.updated_at = now.toISOString();
    await persist_state();
    if (row.exited_qty > previous_exited_qty) {
      await write_trade_event('exit_order_fill_progress', {
        ...fields,
        exited_qty: row.exited_qty,
        exit_fill_avg_price: row.exit_fill_price,
        broker_order_status: exit_order.orderStatus,
        trigger: row.exit_trigger || null,
      });
    }
    if (row.exited_qty >= finite_number(row.filled_qty, 0)
      && row.exited_qty > 0
      && experiment_all_variants_flat(row.experiment_ledger)) {
      row.status = 'closed';
      row.pending_exit_qty = 0;
      row.exit_order_id = null;
      row.exit_order_id_ex = null;
      const multiplier = positive_number(row.contract_multiplier, 100);
      const weighted_exit_fill_price = finite_number(row.exit_fill_value, 0) / row.exited_qty;
      row.weighted_exit_fill_price = Number(weighted_exit_fill_price.toFixed(6));
      row.realized_pnl_usd = row.entry_fill_unpriced === true
        ? null
        : Number(((weighted_exit_fill_price - positive_number(row.entry_fill_price, 0))
          * row.exited_qty * multiplier).toFixed(2));
      row.realized_pnl_status = row.entry_fill_unpriced === true ? 'unpriced' : 'priced';
      recompute_session_risk(state);
      await persist_state();
      await write_experiment_event('experiment_cohort_closed', row, {
        aggregate_qty: row.exited_qty,
        aggregate_realized_pnl_usd: row.realized_pnl_usd,
      });
      await write_trade_event('position_closed', {
        ...fields,
        qty: row.exited_qty,
        entry_fill_price: row.entry_fill_price,
        exit_fill_price: row.weighted_exit_fill_price,
        realized_pnl_usd: row.realized_pnl_usd,
        trigger: row.exit_trigger || null,
      });
      return { submitted: false, closed: true };
    }
    if (terminal) {
      reset_experiment_exit_attempt(row, now);
      await persist_state();
      await write_experiment_event('experiment_exit_terminal_retry_pending', row, {
        broker_order_status: exit_order.orderStatus,
        remaining_qty: experiment_total_remaining_qty(row.experiment_ledger),
      });
    } else if (allow_execution && force_close && row.exit_order_type === 'limit' && !row.exit_cancel_requested_at) {
      try {
        await with_timeout(cancelOrder(runtime.client, runtime.config, {
          orderID: broker_order_identity(exit_order).order_id || row.exit_order_id,
          orderIDEx: row.exit_order_id_ex,
        }), 10_000, 'cancel experiment force-close limit order');
        row.exit_cancel_requested_at = now.toISOString();
        row.updated_at = now.toISOString();
        await persist_state();
      } catch (error) {
        row.last_error = sanitized_error(error);
        await persist_state();
      }
    }
    return { submitted: false, active: !terminal };
  }

  const invariant = junk_experiment_ownership_invariant(row, position);
  if (!invariant.passed) {
    row.status = 'recovery_blocked';
    row.last_error = invariant.reasons.join(',');
    row.experiment_ledger.ownership_status = 'recovery_blocked';
    state.broker_recovery = {
      ...(state.broker_recovery || {}),
      status: 'blocked',
      checked_at: now.toISOString(),
      error_code: 'experiment_broker_ledger_qty_mismatch',
    };
    await persist_state();
    await write_experiment_event('experiment_ownership_invariant_failed', row, invariant);
    return { submitted: false, blocked: true };
  }
  if (experiment_all_variants_flat(row.experiment_ledger)) return { submitted: false };

  const allocations = {};
  const reason_by_line = {};
  const management_by_line = {};
  const triggered_line_ids = [];
  const emergency_unpriced_force_close = row.experiment_unpriced_force_close === true
    && row.entry_fill_unpriced === true
    && positive_number(row.entry_fill_price) === null;
  if (emergency_unpriced_force_close && emergency_submission_allowed !== true) {
    const expired = typeof row.expiration === 'string'
      && row.expiration.length > 0
      && row.expiration !== session_date_et;
    row.status = 'recovery_blocked';
    row.last_error = expired
      ? 'experiment_unpriced_force_close_expired_manual_reconciliation'
      : 'experiment_unpriced_force_close_outside_emergency_window';
    row.experiment_ledger.ownership_status = 'recovery_blocked';
    row.updated_at = now.toISOString();
    await persist_state();
    await write_experiment_event('experiment_unpriced_force_close_submission_blocked', row, {
      reason: row.last_error,
      expiration: row.expiration || null,
      session_date_et: session_date_et || null,
      force_close,
    });
    return { submitted: false, blocked: true };
  }
  for (const [line_id, current_variant] of Object.entries(row.experiment_ledger.variants || {}).sort()) {
    const current_remaining_qty = experiment_variant_remaining_qty(current_variant);
    if (current_remaining_qty < 1) {
      clear_experiment_exit_latch(row, line_id);
      continue;
    }
    if (emergency_unpriced_force_close) {
      const latch = {
        kind: 'full',
        reason: 'experiment_unpriced_entry_force_close',
        remaining_qty: current_remaining_qty,
        management_update: {},
      };
      set_experiment_exit_latch(row, line_id, latch);
      allocations[line_id] = current_remaining_qty;
      reason_by_line[line_id] = latch.reason;
      management_by_line[line_id] = {};
      triggered_line_ids.push(line_id);
      continue;
    }
    const variant_config = exit_config_for_variant(exit_config, current_variant);
    const variant_plan = buildZeroDteSimulatedExitPlan({
      owned_position: experiment_variant_owned_position(row, current_variant),
      option_snapshot,
      underlying_price_usd,
      config: variant_config,
      now,
    });
    const defer_partial_management = current_variant.partial_target_taken !== true
      && variant_plan.management_update?.partial_target_taken === true;
    const durable_management_update = defer_partial_management
      ? {
        ...variant_plan.management_update,
        partial_target_taken: false,
        management_floor_pct: current_variant.management_floor_pct,
      }
      : variant_plan.management_update;
    row.experiment_ledger = update_junk_experiment_variant_management(
      row.experiment_ledger,
      line_id,
      durable_management_update,
    );
    const variant = row.experiment_ledger.variants[line_id];
    if (variant_plan.management_update?.breakeven_armed === true && current_variant.breakeven_armed !== true) {
      await write_experiment_event('experiment_line_breakeven_armed', row, {
        line_id,
        option_return_pct: variant.option_return_pct,
        peak_option_return_pct: variant.peak_option_return_pct,
      });
    }
    const prior_latch = experiment_exit_latch(row, line_id);
    const latch = advance_junk_experiment_exit_latch(
      prior_latch,
      variant_plan,
      experiment_variant_remaining_qty(variant),
    );
    if (latch) set_experiment_exit_latch(row, line_id, latch);
    if (!latch) continue;
    const requested = Math.min(
      experiment_variant_remaining_qty(variant),
      Math.max(0, Math.floor(finite_number(latch.remaining_qty, 0))),
    );
    if (requested > 0) {
      allocations[line_id] = requested;
      reason_by_line[line_id] = latch.reason;
      management_by_line[line_id] = latch.management_update || {};
      triggered_line_ids.push(line_id);
    }
  }
  const unallocated_qty = experiment_unallocated_remaining_qty(row.experiment_ledger);
  if (unallocated_qty > 0) {
    allocations.__unallocated__ = unallocated_qty;
    reason_by_line.__unallocated__ = emergency_unpriced_force_close
      ? 'experiment_unpriced_entry_force_close'
      : 'experiment_unallocated_entry_liquidation';
  }
  row.status = 'open';
  row.updated_at = now.toISOString();
  await persist_state();
  const aggregate_requested_qty = Object.values(allocations).reduce((sum, qty) => sum + qty, 0);
  if (aggregate_requested_qty < 1) return { submitted: false };
  if (finite_number(position?.canSellQty, 0) < aggregate_requested_qty) {
    row.status = 'recovery_blocked';
    row.last_error = `experiment_requested_exit_exceeds_broker_can_sell:${aggregate_requested_qty}:${finite_number(position?.canSellQty, 0)}`;
    row.experiment_ledger.ownership_status = 'recovery_blocked';
    await persist_state();
    await write_experiment_event('experiment_exit_sellability_invariant_failed', row, {
      aggregate_requested_qty,
      broker_can_sell_qty: finite_number(position?.canSellQty, 0),
    });
    return { submitted: false, blocked: true };
  }
  const aggregate_owned_position = {
    ...exit_owned_position(row),
    experiment_id: row.experiment_ledger.experiment_id,
    cohort_id: row.experiment_ledger.cohort_id,
    experiment_line_ids: triggered_line_ids,
    pending_exit_qty: 0,
  };
  const reason = emergency_unpriced_force_close
    ? 'experiment_unpriced_entry_force_close'
    : (unallocated_qty > 0 && triggered_line_ids.length === 0
      ? 'experiment_unallocated_entry_liquidation'
      : 'experiment_variant_exit_batch');
  let exit_plan = buildZeroDteSimulatedExplicitExitPlan({
    owned_position: aggregate_owned_position,
    option_snapshot,
    requested_exit_qty: aggregate_requested_qty,
    reason,
    trigger_type: 'experiment_aggregate_exit',
    order_type: emergency_unpriced_force_close || force_close ? 'market' : 'limit',
    allow_unpriced_market_force_close: emergency_unpriced_force_close,
    config: exit_config,
    now,
  });
  if (!exit_plan.gate.passed) {
    await append_json_line(exit_plans_path, exit_plan);
    return { submitted: false };
  }
  if (!allow_execution) {
    await append_json_line(exit_plans_path, {
      ...exit_plan,
      experiment_allocations: allocations,
      experiment_reason_by_line: reason_by_line,
    });
    return { submitted: false };
  }
  const exit_attempt_no = Math.max(0, Math.trunc(finite_number(row.exit_attempt_no, 0))) + 1;
  const remark = experiment_exit_attempt_remark(row, exit_attempt_no);
  exit_plan = {
    ...exit_plan,
    exit_attempt_no,
    experiment_allocations: allocations,
    experiment_reason_by_line: reason_by_line,
    order: { ...exit_plan.order, remark },
  };
  row.experiment_ledger = begin_junk_experiment_exit_batch(row.experiment_ledger, {
    allocations,
    reason_by_line,
    attempt_no: exit_attempt_no,
    remark,
    now,
  });
  row.experiment_exit_management_by_line = management_by_line;
  row.status = 'exit_intent';
  row.exit_attempt_no = exit_attempt_no;
  row.exit_remark = remark;
  row.exit_order_id = null;
  row.exit_order_id_ex = null;
  row.pending_exit_qty = aggregate_requested_qty;
  row.exit_base_exited_qty = finite_number(row.exited_qty, 0);
  row.exit_submitted_price = exit_plan.order.price || null;
  row.exit_order_type = exit_plan.order.order_type || null;
  row.exit_trigger = { ...exit_plan.trigger, line_ids: triggered_line_ids, allocations };
  row.exit_intent_at = now.toISOString();
  row.exit_order_accounted_fill_qty = 0;
  row.exit_order_accounted_fill_value = 0;
  row.updated_at = now.toISOString();
  await append_json_line(exit_plans_path, exit_plan);
  await persist_state();
  await write_experiment_event('experiment_exit_batch_intent', row, {
    allocations,
    reason_by_line,
    aggregate_requested_qty,
    remark,
  });
  let execution;
  try {
    execution = await executeZeroDteSimulatedExit({
      client: runtime.client,
      config: exit_config,
      plan: exit_plan,
      now,
    });
  } catch (error) {
    if (error?.submission_outcome === 'not_submitted') {
      row.experiment_ledger = apply_junk_experiment_exit_cumulative_fill(row.experiment_ledger, {
        cumulative_fill_qty: 0,
        cumulative_fill_avg_price: 0,
        terminal: true,
        now,
      }).ledger;
      reset_experiment_exit_attempt(row, now);
      row.last_error = sanitized_error(error);
      await persist_state();
      return { submitted: false };
    }
    row.status = 'exit_submission_unknown';
    row.last_error = sanitized_error(error);
    row.updated_at = new Date().toISOString();
    await persist_state();
    throw error;
  }
  if (execution.order_status !== 'submitted_simulation_exit') {
    row.experiment_ledger = apply_junk_experiment_exit_cumulative_fill(row.experiment_ledger, {
      cumulative_fill_qty: 0,
      cumulative_fill_avg_price: 0,
      terminal: true,
      now,
    }).ledger;
    reset_experiment_exit_attempt(row, now);
    row.last_error = execution.execution?.reason || 'experiment_exit_not_submitted';
    await persist_state();
    await append_json_line(exit_plans_path, execution);
    return { submitted: false };
  }
  if (!has_broker_order_identity(execution.execution)) {
    row.status = 'exit_submission_unknown';
    row.last_error = 'experiment_exit_submission_accepted_without_broker_order_identity';
    row.updated_at = new Date().toISOString();
    await persist_state();
    await append_json_line(exit_plans_path, execution);
    return { submitted: false };
  }
  row.status = 'exit_submitted';
  apply_broker_order_identity(row, 'exit', execution.execution);
  row.pending_exit_qty = execution.execution.submitted_qty;
  row.exit_submitted_at = execution.execution.submitted_at;
  row.exit_cancel_requested_at = null;
  row.updated_at = now.toISOString();
  await persist_state();
  await append_json_line(exit_plans_path, execution);
  await write_trade_event('exit_order_submitted', {
    ...fields,
    line_ids: triggered_line_ids,
    allocations,
    qty: execution.execution.submitted_qty,
    order_type: row.exit_order_type,
    price: row.exit_submitted_price,
    order_id: row.exit_order_id,
    order_id_ex: row.exit_order_id_ex,
    trigger: row.exit_trigger,
  });
  return { submitted: true };
}

async function reconcile_line_orders({
  runtime,
  state,
  now,
  underlying_price_usd,
  allow_execution,
  persist_state,
  schedule = market_schedule(runtime.config.policy, ny_context(now)),
}) {
  const active_rows = active_order_rows(state);
  if (active_rows.length === 0) return { watched: 0, submitted_exits: 0, quote_error: null };
  const orders_response = await with_timeout(
    fetchOrderList(runtime.client, runtime.config), 10_000, 'GetOrderList',
  );
  const fills_response = await fetch_optional_order_fills(runtime, 'GetOrderFillList');
  const positions_response = await with_timeout(
    fetchPositionList(runtime.client, runtime.config), 10_000, 'GetPositionList',
  );
  const orders = order_map(orders_response);
  const order_rows = broker_rows(orders_response, 'orderList');
  const fill_rows = broker_rows(fills_response, 'orderFillList');
  const position_rows = broker_rows(positions_response, 'positionList');
  const fills_by_order = fill_identity_map(fill_rows);
  const positions_by_code = new Map(position_rows
    .filter((row) => row?.code)
    .map((row) => [String(row.code), row]));
  const option_securities = active_rows
    .filter((row) => positive_number(row.filled_qty) !== null && row.code)
    .map((row) => ({ market: finite_number(row.contract_market, QOT_MARKET_US_SECURITY), code: row.code }));
  let option_snapshots = new Map();
  let quote_error = null;
  if (option_securities.length > 0) {
    try {
      const quote_result = await with_timeout(runtime.quote_feed.getSnapshots(option_securities, {
        orderBookSecurities: option_securities,
      }), 10_000, 'option quote snapshot');
      option_snapshots = new Map((quote_result.snapshots || [])
        .filter((snapshot) => snapshot?.basic?.security?.code)
        .map((snapshot) => [String(snapshot.basic.security.code), snapshot]));
    } catch (error) {
      quote_error = sanitized_error(error);
    }
  }

  let submitted_exits = 0;
  const ttl_seconds = positive_number(runtime.config.policy?.risk_limits?.entry_order_ttl_seconds, 45);
  const session_date_et = ny_context(now).date_key;
  const force_close = schedule.market_open && ny_context(now).minutes >= schedule.force_close_start_minutes;
  const exit_config = exit_config_for_schedule(runtime.config, schedule);

  for (const row of active_rows) {
    const expected_entry_remark = row.entry_remark || `junk_gex:${row.signal_id}`.slice(0, 60);
    let buy_order = find_by_row_identity(orders, row, 'entry')
      || order_rows.find((order) => broker_remark(order) === expected_entry_remark)
      || null;
    const entry_identity_was_missing = !row_has_order_identity(row, 'entry');
    if (buy_order) apply_broker_order_identity(row, 'entry', buy_order);
    if (buy_order && entry_identity_was_missing) {
      row.entry_remark = broker_remark(buy_order);
      row.status = 'entry_submitted';
      row.last_error = null;
      row.updated_at = now.toISOString();
      recompute_session_risk(state);
      await persist_state();
    }
    const buy_fill_rows = fills_for_identity(fills_by_order, buy_order || {
        order_id: row.entry_order_id,
        order_id_ex: row.entry_order_id_ex,
      });
    const buy_fill = is_junk_experiment_row(row)
      ? resolve_junk_experiment_entry_fill({
        row,
        broker_order: buy_order,
        fills: buy_fill_rows,
        positions: position_rows,
        ownership_rows: active_rows,
      })
      : broker_fill_summary(buy_order, buy_fill_rows);
    const broker_filled_qty = buy_fill.qty;
    const previous_filled_qty = finite_number(row.filled_qty, 0);
    if (broker_filled_qty > previous_filled_qty) {
      row.filled_qty = Math.min(finite_number(row.submitted_qty, broker_filled_qty), broker_filled_qty);
      if (is_junk_experiment_row(row)) {
        row.entry_fill_price = buy_fill.avg_price;
        row.entry_fill_price_source = buy_fill.source || null;
      } else {
        row.entry_fill_price = buy_fill.avg_price ?? positive_number(row.entry_limit_price);
      }
      row.entry_filled_at ||= now.toISOString();
      row.status = row_has_order_identity(row, 'exit') ? 'exit_submitted' : 'open';
      row.updated_at = now.toISOString();
      await persist_state();
      await write_trade_event('entry_order_filled', {
        ...experiment_event_fields(row),
        plan_id: row.plan_id,
        signal_id: row.signal_id,
        code: row.code,
        filled_qty: row.filled_qty,
        fill_avg_price: row.entry_fill_price,
        broker_order_status: buy_order?.orderStatus ?? null,
      });
    }
    if (is_junk_experiment_row(row)
      && broker_filled_qty > 0
      && (buy_fill.trusted !== true || positive_number(buy_fill.avg_price) === null)) {
      row.filled_qty = Math.max(previous_filled_qty, broker_filled_qty);
      row.entry_fill_price = null;
      row.entry_fill_price_source = null;
      state.broker_recovery = {
        ...(state.broker_recovery || {}),
        status: 'blocked',
        checked_at: now.toISOString(),
        error_code: 'experiment_entry_fill_average_missing',
      };
      const emergency_close_due = junk_experiment_unpriced_emergency_window({
        schedule,
        force_close,
        expiration: row.expiration,
        session_date_et,
      });
      if (row.experiment_unpriced_force_close !== true
        && buy_order
        && !is_terminal_broker_order(buy_order?.orderStatus)) {
        if (allow_execution) {
          await cancel_entry_if_needed(
            runtime,
            row,
            buy_order,
            now,
            'unpriced_partial_entry_must_be_terminal_before_force_close',
            persist_state,
          );
        }
      }
      let emergency_arm = null;
      if (row.experiment_unpriced_force_close !== true
        && emergency_close_due
        && allow_execution
        && is_terminal_broker_order(buy_order?.orderStatus)) {
        emergency_arm = arm_junk_experiment_unpriced_force_close({
          row,
          broker_order: buy_order,
          positions: position_rows,
          // Ownership proof must include terminal local rows that still claim
          // positive quantity; active_rows intentionally filters those out.
          ownership_rows: junk_experiment_ownership_rows(state),
          now,
        });
      }
      if (row.experiment_unpriced_force_close !== true) {
        row.status = 'recovery_blocked';
        row.last_error = emergency_arm && !emergency_arm.armed
          ? `experiment_unpriced_force_close_ownership_not_proven:${emergency_arm.proof.reasons.join(',')}`
          : 'experiment_entry_fill_average_missing_recovery_blocked';
        row.experiment_ledger.ownership_status = 'recovery_blocked';
      }
      row.updated_at = now.toISOString();
      await persist_state();
      await write_experiment_event(
        row.experiment_unpriced_force_close === true
          ? 'experiment_unpriced_force_close_armed'
          : 'experiment_entry_fill_average_missing',
        row,
        {
        filled_qty: broker_filled_qty,
          physical_remaining_qty: emergency_arm?.proof?.physical_remaining_qty || null,
          ownership_proof_reasons: emergency_arm?.proof?.reasons || [],
        },
      );
      if (row.experiment_unpriced_force_close !== true) continue;
    }

    const entry_age_ms = now.getTime() - Date.parse(row.entry_submitted_at || '');
    const submitted_qty = finite_number(row.submitted_qty, 0);
    const entry_position = positions_by_code.get(String(row.code || '')) || null;
    if (!buy_order
      && ['entry_intent', 'entry_submission_unknown', 'entry_submitted', 'recovery_blocked']
        .includes(String(row.status || ''))
      && expired_entry_without_broker_evidence(row, entry_position, ny_context(now).date_key)) {
      row.status = 'expired_no_submission_evidence';
      row.pending_exit_qty = 0;
      row.last_error = 'expired_entry_has_no_broker_order_fill_or_position_evidence';
      row.updated_at = now.toISOString();
      await persist_state();
      await write_trade_event('expired_entry_closed_without_broker_evidence', {
        plan_id: row.plan_id,
        signal_id: row.signal_id,
        code: row.code,
        expiration: row.expiration,
      });
      continue;
    }
    if (!buy_order && !row_has_order_identity(row, 'entry')
      && ['entry_intent', 'entry_submission_unknown'].includes(row.status)) {
      block_unresolved_submission(row, 'entry', now);
      await persist_state();
      continue;
    }
    if (!buy_order && row_has_order_identity(row, 'entry') && row.filled_qty <= 0) {
      row.entry_order_missing_cycles = finite_number(row.entry_order_missing_cycles, 0) + 1;
      row.status = 'recovery_blocked';
      row.last_error = 'entry_order_missing_from_broker_recovery_required';
      row.updated_at = now.toISOString();
      await persist_state();
      continue;
    }
    if (row.orphan_experiment_entry === true) {
      row.status = 'recovery_blocked';
      row.last_error = 'experiment_entry_plan_missing_virtual_ownership_recovery_blocked';
      row.updated_at = now.toISOString();
      await persist_state();
      continue;
    }
    if (allow_execution
      && finite_number(row.filled_qty, 0) < submitted_qty
      && Number.isFinite(entry_age_ms)
      && entry_age_ms >= ttl_seconds * 1000
      && !is_terminal_broker_order(buy_order?.orderStatus)) {
      await cancel_entry_if_needed(runtime, row, buy_order, now, 'entry_order_ttl_expired', persist_state);
    }
    if (allow_execution
      && finite_number(row.filled_qty, 0) > 0
      && finite_number(row.filled_qty, 0) < submitted_qty) {
      await cancel_entry_if_needed(runtime, row, buy_order, now, 'partial_fill_prevent_remainder', persist_state);
    }
    if (live_entry_remainder_pending(row, buy_order)) {
      row.status = 'entry_partial_cancel_pending';
      row.last_error = 'entry_remainder_must_be_terminal_before_exit';
      row.updated_at = now.toISOString();
      await persist_state();
      continue;
    }
    if (finite_number(row.filled_qty, 0) <= 0 && is_terminal_unfilled_broker_order(buy_order?.orderStatus)) {
      row.status = Number(buy_order?.orderStatus) === 3 ? 'submit_failed' : 'entry_unfilled_terminal';
      row.updated_at = now.toISOString();
      await persist_state();
      await write_trade_event('entry_order_unfilled_terminal', {
        ...experiment_event_fields(row),
        plan_id: row.plan_id,
        signal_id: row.signal_id,
        code: row.code,
        broker_order_status: buy_order?.orderStatus ?? null,
      });
      continue;
    }

    if (is_junk_experiment_row(row)) {
      const allocation = finalize_junk_experiment_entry_if_terminal(row, buy_order, now);
      if (allocation.finalized) {
        await persist_state();
        await write_experiment_event('experiment_entry_allocation_finalized', row, {
          aggregate_filled_qty: row.filled_qty,
          allocated_entry_qty: row.experiment_ledger.allocated_entry_qty,
          per_line_allocated_qty: Object.fromEntries(Object.entries(row.experiment_ledger.variants || {})
            .map(([line_id, variant]) => [line_id, variant.allocated_entry_qty])),
          unallocated_entry_qty: row.experiment_ledger.unallocated_entry_qty,
          allocation_quality: row.experiment_ledger.allocation_quality,
        });
        for (const variant of Object.values(row.experiment_ledger.variants || {})) {
          await write_experiment_event('experiment_line_entry_allocated', row, {
            line_id: variant.line_id,
            qty: variant.allocated_entry_qty,
            fill_price: row.experiment_ledger.entry_fill_avg_price,
            entry_value: variant.allocated_entry_value,
            exit_profile_hash: variant.exit_profile_hash,
            exit_profile: variant.exit_profile,
          });
          await write_trade_event('experiment_line_entry_allocated', {
            ...experiment_event_fields(row),
            plan_id: row.plan_id,
            signal_id: row.signal_id,
            code: row.code,
            line_id: variant.line_id,
            qty: variant.allocated_entry_qty,
            fill_price: row.experiment_ledger.entry_fill_avg_price,
            entry_value: variant.allocated_entry_value,
            exit_profile_hash: variant.exit_profile_hash,
            exit_profile: variant.exit_profile,
          });
        }
        await write_trade_event('experiment_entry_allocation_finalized', {
          ...experiment_event_fields(row),
          plan_id: row.plan_id,
          signal_id: row.signal_id,
          code: row.code,
          aggregate_filled_qty: row.filled_qty,
          unallocated_entry_qty: row.experiment_ledger.unallocated_entry_qty,
        });
      }
      if (row.experiment_ledger.entry_allocation_finalized !== true) {
        row.status = 'entry_allocation_waiting_terminal';
        row.last_error = 'experiment_entry_allocation_requires_terminal_buy_order';
        row.updated_at = now.toISOString();
        await persist_state();
        continue;
      }
    }

    const position = entry_position;
    if (position) {
      row.position_id = position.positionID || position.positionId || row.position_id || null;
      row.broker_position_qty = finite_number(position.qty);
      row.broker_can_sell_qty = finite_number(position.canSellQty);
    }
    if (is_junk_experiment_row(row)) {
      const experiment_result = await reconcile_junk_experiment_row({
        runtime,
        state,
        row,
        now,
        underlying_price_usd,
        allow_execution,
        persist_state,
        exit_config,
        force_close,
        emergency_submission_allowed: junk_experiment_unpriced_emergency_window({
          schedule,
          force_close,
          expiration: row.expiration,
          session_date_et,
        }),
        session_date_et,
        position,
        orders,
        order_rows,
        fills_by_order,
        option_snapshot: option_snapshots.get(String(row.code)) || null,
      });
      if (experiment_result.submitted) submitted_exits += 1;
      continue;
    }
    const expected_exit_remark = row.exit_remark || null;
    let exit_order = find_by_row_identity(orders, row, 'exit')
      || (expected_exit_remark
        ? order_rows.find((order) => broker_remark(order) === expected_exit_remark)
        : null)
      || null;
    if (!exit_order && row_has_order_identity(row, 'exit')) {
      const recovered_exit_fill = broker_fill_summary(
        null,
        fills_for_identity(fills_by_order, {
          order_id: row.exit_order_id,
          order_id_ex: row.exit_order_id_ex,
        }),
      );
      if (recovered_exit_fill.qty > 0) {
        exit_order = {
          orderID: row.exit_order_id,
          orderIDEx: row.exit_order_id_ex,
          orderStatus: 4,
          fillQty: recovered_exit_fill.qty,
          fillAvgPrice: recovered_exit_fill.avg_price,
          remark: expected_exit_remark || exit_remark_base(row),
        };
      }
    }
    const exit_identity_was_missing = !row_has_order_identity(row, 'exit');
    if (exit_order) apply_broker_order_identity(row, 'exit', exit_order);
    if (exit_order && exit_identity_was_missing) {
      row.exit_remark = broker_remark(exit_order);
      row.status = 'exit_submitted';
      row.last_error = null;
      row.updated_at = now.toISOString();
      await persist_state();
    }

    if (!exit_order && ['exit_intent', 'exit_submission_unknown'].includes(row.status)) {
      block_unresolved_submission(row, 'exit', now);
      await persist_state();
      continue;
    }

    if (row_has_order_identity(row, 'exit')) {
      if (!exit_order) {
        row.exit_order_missing_cycles = finite_number(row.exit_order_missing_cycles, 0) + 1;
        row.status = 'recovery_blocked';
        row.last_error = 'exit_order_missing_from_broker_recovery_required';
        row.updated_at = now.toISOString();
        await persist_state();
        continue;
      }
      row.exit_order_missing_cycles = 0;
      const exit_fill = broker_fill_summary(exit_order, fills_for_identity(fills_by_order, exit_order));
      const { previous_exited_qty } = apply_exit_cumulative_fill(row, exit_fill);
      row.updated_at = now.toISOString();
      await persist_state();

      if (row.exited_qty > previous_exited_qty) {
        await write_trade_event('exit_order_fill_progress', {
          plan_id: row.plan_id,
          signal_id: row.signal_id,
          code: row.code,
          exited_qty: row.exited_qty,
          exit_fill_avg_price: row.exit_fill_price,
          broker_order_status: exit_order?.orderStatus ?? null,
          trigger: row.exit_trigger || null,
        });
      }
      if (row.exited_qty >= finite_number(row.filled_qty, 0) && row.exited_qty > 0) {
        row.status = 'closed';
        row.pending_exit_qty = 0;
        row.exit_order_id = null;
        row.exit_order_id_ex = null;
        const multiplier = positive_number(row.contract_multiplier, 100);
        const weighted_exit_fill_price = finite_number(row.exit_fill_value, 0) / row.exited_qty;
        const realized_pnl_usd = Number(((weighted_exit_fill_price - positive_number(row.entry_fill_price, 0))
          * row.exited_qty * multiplier).toFixed(2));
        row.weighted_exit_fill_price = Number(weighted_exit_fill_price.toFixed(6));
        row.realized_pnl_usd = realized_pnl_usd;
        state.daily_realized_pnl_usd = Number(Object.values(state.orders || {})
          .filter((owned) => owned.status === 'closed' && owned.expiration === state.session_date_et)
          .reduce((sum, owned) => sum + finite_number(owned.realized_pnl_usd, 0), 0)
          .toFixed(2));
        await persist_state();
        await write_trade_event('position_closed', {
          plan_id: row.plan_id,
          signal_id: row.signal_id,
          code: row.code,
          qty: row.exited_qty,
          entry_fill_price: row.entry_fill_price,
          exit_fill_price: row.weighted_exit_fill_price,
          realized_pnl_usd,
          trigger: row.exit_trigger || null,
        });
        continue;
      }
      if (is_terminal_broker_order(exit_order?.orderStatus)) {
        row.status = 'open';
        row.exit_order_id = null;
        row.exit_order_id_ex = null;
        row.exit_remark = null;
        row.pending_exit_qty = 0;
        row.exit_base_exited_qty = row.exited_qty;
        row.exit_order_accounted_fill_qty = 0;
        row.exit_order_accounted_fill_value = 0;
        row.updated_at = now.toISOString();
        await persist_state();
        await write_trade_event('exit_order_terminal_retry_pending', {
          plan_id: row.plan_id,
          signal_id: row.signal_id,
          code: row.code,
          exited_qty: row.exited_qty,
          broker_order_status: exit_order?.orderStatus ?? null,
        });
      } else if (allow_execution && force_close && row.exit_order_type === 'limit' && !row.exit_cancel_requested_at) {
        try {
          await with_timeout(cancelOrder(runtime.client, runtime.config, {
            orderID: broker_order_identity(exit_order).order_id || row.exit_order_id,
            orderIDEx: row.exit_order_id_ex,
          }), 10_000, 'cancel force-close limit order');
          row.exit_cancel_requested_at = now.toISOString();
          row.updated_at = now.toISOString();
          await persist_state();
          await write_trade_event('exit_limit_cancel_requested_for_force_close', {
            plan_id: row.plan_id,
            signal_id: row.signal_id,
            code: row.code,
            exit_order_id: row.exit_order_id,
            exit_order_id_ex: row.exit_order_id_ex,
          });
        } catch (error) {
          row.last_error = sanitized_error(error);
          await persist_state();
        }
      }
      continue;
    }

    if (finite_number(row.filled_qty, 0) <= finite_number(row.exited_qty, 0)) continue;
    const option_snapshot = option_snapshots.get(String(row.code)) || null;
    const recovered_partial_target_taken = row.partial_target_taken === true
      || (
        finite_number(row.exited_qty, 0) > 0
        && row.exit_trigger?.structural_target_exit === 'partial'
      );
    const owned_position = {
      ...exit_owned_position(row),
      entry_at: row.entry_filled_at || row.entry_fill_at || row.entry_submitted_at || null,
      setup_type: row.setup_type || row.node_reaction || row.signal_type || null,
      partial_target_taken: recovered_partial_target_taken,
      management_floor_pct: finite_number(row.management_floor_pct),
    };
    let exit_plan = buildZeroDteSimulatedExitPlan({
      owned_position,
      option_snapshot,
      underlying_price_usd,
      config: exit_config,
      now,
    });
    if (recovered_partial_target_taken && exit_plan.management_update?.partial_target_taken === true) {
      row.partial_target_taken = true;
      row.management_floor_pct = Math.max(
        0,
        finite_number(row.management_floor_pct, 0),
        finite_number(exit_plan.management_update.management_floor_pct, 0),
      );
    }
    const management_state = apply_exit_management_update(row, exit_plan.management_update);
    row.status = 'open';
    row.updated_at = now.toISOString();
    // Persist the monotonic armed/peak state before emitting the one-time event or taking an early continue.
    await persist_state();
    if (management_state.newly_armed) {
      await write_trade_event('option_breakeven_armed', {
        plan_id: row.plan_id,
        signal_id: row.signal_id,
        code: row.code,
        option_return_pct: row.option_return_pct,
        peak_option_return_pct: row.peak_option_return_pct,
      });
    }
    if (!exit_plan.gate.passed) continue;

    if (!allow_execution) {
      await append_json_line(exit_plans_path, exit_plan);
      continue;
    }
    const exit_attempt_no = Math.max(0, Math.trunc(finite_number(row.exit_attempt_no, 0))) + 1;
    const exit_attempt_remark = build_exit_attempt_remark(row.plan_id, exit_attempt_no);
    exit_plan = {
      ...exit_plan,
      exit_attempt_no,
      order: { ...exit_plan.order, remark: exit_attempt_remark },
    };
    await append_json_line(exit_plans_path, exit_plan);
    row.status = 'exit_intent';
    row.exit_attempt_no = exit_attempt_no;
    row.exit_remark = exit_attempt_remark;
    row.exit_order_id = null;
    row.exit_order_id_ex = null;
    row.pending_exit_qty = exit_plan.order?.qty || 0;
    row.exit_base_exited_qty = finite_number(row.exited_qty, 0);
    row.exit_submitted_price = exit_plan.order?.price || null;
    row.exit_order_type = exit_plan.order?.order_type || null;
    row.exit_trigger = exit_plan.trigger || null;
    row.exit_intent_at = now.toISOString();
    row.exit_order_missing_cycles = 0;
    row.exit_order_accounted_fill_qty = 0;
    row.exit_order_accounted_fill_value = 0;
    row.updated_at = now.toISOString();
    await persist_state();
    let execution;
    try {
      execution = await executeZeroDteSimulatedExit({
        client: runtime.client,
        config: exit_config,
        plan: exit_plan,
        now,
      });
    } catch (error) {
      if (error?.submission_outcome === 'not_submitted') {
        row.status = 'open';
        row.pending_exit_qty = 0;
        row.exit_order_id = null;
        row.exit_order_id_ex = null;
        row.exit_remark = null;
        row.last_error = sanitized_error(error);
        row.updated_at = new Date().toISOString();
        await persist_state();
        await write_trade_event('exit_preflight_failed_not_submitted', {
          plan_id: row.plan_id,
          signal_id: row.signal_id,
          code: row.code,
          submission_phase: error.submission_phase || null,
          error: row.last_error,
        });
        continue;
      }
      row.status = 'exit_submission_unknown';
      row.last_error = sanitized_error(error);
      row.updated_at = new Date().toISOString();
      await persist_state();
      throw error;
    }
    if (execution.order_status !== 'submitted_simulation_exit') {
      row.status = 'open';
      row.pending_exit_qty = 0;
      row.exit_remark = null;
      row.last_error = execution.execution?.reason || 'exit_not_submitted';
      row.updated_at = new Date().toISOString();
      await persist_state();
      await append_json_line(exit_plans_path, execution);
      continue;
    }
    if (!has_broker_order_identity(execution.execution)) {
      row.status = 'exit_submission_unknown';
      row.last_error = 'exit_submission_accepted_without_broker_order_identity';
      row.updated_at = new Date().toISOString();
      await persist_state();
      await append_json_line(exit_plans_path, execution);
      continue;
    }
    submitted_exits += 1;
    row.status = 'exit_submitted';
    apply_broker_order_identity(row, 'exit', execution.execution);
    row.pending_exit_qty = execution.execution.submitted_qty;
    row.exit_submitted_at = execution.execution.submitted_at;
    row.exit_cancel_requested_at = null;
    row.updated_at = now.toISOString();
    await persist_state();
    await append_json_line(exit_plans_path, execution);
    await write_trade_event('exit_order_submitted', {
      plan_id: row.plan_id,
      signal_id: row.signal_id,
      code: row.code,
      qty: execution.execution.submitted_qty,
      order_type: row.exit_order_type,
      price: row.exit_submitted_price,
      order_id: row.exit_order_id,
      order_id_ex: row.exit_order_id_ex,
      trigger: row.exit_trigger,
    });
  }
  return { watched: active_rows.length, submitted_exits, quote_error };
}

function compact_decision(decision) {
  if (!decision) return null;
  return {
    generated_at: decision.generated_at || null,
    decision: decision.decision,
    action: decision.action,
    reason_codes: decision.reason_codes,
    direction: decision.direction || null,
    signal_type: decision.signal_type || null,
    snapshot_at: decision.snapshot_at,
    snapshot_state: decision.snapshot_state,
    spot_usd: decision.spot_usd,
    vwap_usd: decision.vwap_usd,
    tested_node: decision.tested_node || null,
    target_underlying_usd: decision.target_underlying_usd || null,
    stop_underlying_usd: decision.stop_underlying_usd || null,
    option_selection: decision.option_selection || null,
    model_version: decision.model_version || null,
    evidence_model: decision.evidence_model ? {
      primary_trigger: decision.evidence_model.primary_trigger || null,
      confirmations: decision.evidence_model.confirmations || [],
      vetoes: decision.evidence_model.vetoes || [],
      source_message_ids: decision.evidence_model.source_message_ids || [],
      source_event_ids: decision.evidence_model.source_event_ids || [],
      heatmap_assessment: decision.evidence_model.heatmap?.assessment || null,
      automated_flow_assessment: decision.evidence_model.automated_flow?.assessment || null,
      contract_confirmation_assessment: decision.evidence_model.contract_confirmation?.assessment || null,
    } : null,
  };
}

async function discord_flow_source_connected(now_ms = Date.now()) {
  const status = await read_json(capture_status_path, null);
  if (!status || String(status.status || '').toLowerCase() !== 'capturing') return false;
  const activity_ms = Date.parse(status.last_gateway_event_at || status.updated_at || '');
  return Number.isFinite(activity_ms) && Number(now_ms) - activity_ms <= 5 * 60 * 1000;
}

async function write_status(payload) {
  await write_json(status_path, {
    updated_at: new Date().toISOString(),
    business_line: ZERO_DTE_BUSINESS_LINE,
    strategy: JUNK_GEX_STRATEGY,
    strategy_label: 'JUNKMAN',
    enabled: business_line.enabled,
    flow_dependency: 'none',
    automated_flow_usage: 'confirmation_context_only',
    execution_environment: 'simulate_only',
    real_trading_allowed: false,
    paper_equity_usd: 10000,
    ...payload,
  });
}

export async function run_zero_dte_line(cli_args = process.argv.slice(2)) {
  const args = parseCliArgs(cli_args);
  if (flag(args['execute-real'])) {
    throw new Error('JUNKMAN GEX is simulation-only; real execution is not implemented or permitted.');
  }

  const status_only = flag(args.status)
    && !flag(args.watch)
    && !flag(args['execute-simulate'])
    && !flag(args.discover)
    && !flag(args['dry-run'])
    && !flag(args['plan-only']);
  if (status_only) {
    const status = await read_json(status_path, {
      phase: 'not_started',
      business_line: ZERO_DTE_BUSINESS_LINE,
      strategy: JUNK_GEX_STRATEGY,
      strategy_label: 'JUNKMAN',
      enabled: business_line.enabled,
      execution_environment: 'simulate_only',
      real_trading_allowed: false,
      paper_equity_usd: 10000,
    });
    console.log(JSON.stringify(status, null, 2));
    return status;
  }

  const config = safe_config(args);
  const exit_experiment = load_junk_exit_experiment(config.policy);
  const provider = config.policy?.provider || {};
  const automated_flow_policy = config.policy?.evidence_gates?.automated_flow_alert || {};
  const contract_audit_policy = config.policy?.evidence_gates?.contract_confirmation || {};
  const locked_flow_identifiers = [
    ['guild_id', NIGHTWATCH_GUILD_ID],
    ['channel_id', NIGHTWATCH_ZERO_DTE_FLOW_CHANNEL_ID],
    ['bot_author_id', NIGHTWATCH_ZERO_DTE_FLOW_BOT_AUTHOR_ID],
  ];
  for (const [field, expected] of locked_flow_identifiers) {
    if (automated_flow_policy[field] && String(automated_flow_policy[field]) !== expected) {
      throw new Error(`JUNKMAN automated Flow ${field} does not match the strict parser allowlist.`);
    }
  }
  if (
    automated_flow_policy.live_max_lag_ms !== undefined
    && finite_number(automated_flow_policy.live_max_lag_ms) !== MAX_LIVE_CAPTURE_LAG_MS
  ) {
    throw new Error('JUNKMAN automated Flow live_max_lag_ms does not match the strict parser gate.');
  }
  if (
    automated_flow_policy.event_log
    && path.resolve(String(automated_flow_policy.event_log)) !== path.resolve(flow_events_path)
  ) {
    throw new Error('JUNKMAN automated Flow event_log must use the isolated business-line log path.');
  }
  const configured_flow_windows_seconds = [...new Set(
    (Array.isArray(automated_flow_policy.windows_seconds)
      ? automated_flow_policy.windows_seconds
      : [60, 180])
      .map((value) => Number(value))
      .filter((value) => value === 60 || value === 180),
  )];
  const flow_windows_seconds = configured_flow_windows_seconds.length > 0
    ? configured_flow_windows_seconds
    : [60, 180];
  if (provider.base_url && provider.base_url !== 'https://api.yehangshe.com') {
    throw new Error('JUNKMAN Nightwatch base_url is locked to https://api.yehangshe.com.');
  }
  if (provider.api_key_env && provider.api_key_env !== 'YEHANGSHE_API_KEY') {
    throw new Error('JUNKMAN Nightwatch api_key_env is locked to YEHANGSHE_API_KEY.');
  }
  const ticker = String(provider.ticker || 'SPX').trim().toUpperCase();
  const poll_ms = Math.max(1000, positive_number(provider.gex_snapshot_poll_seconds, 15) * 1000);
  const heatmap_poll_ms = Math.max(1000, positive_number(provider.heatmap_snapshot_poll_seconds, 60) * 1000);
  const nightwatch = create_nightwatch_rest_client({
    base_url: 'https://api.yehangshe.com',
    api_key_env: 'YEHANGSHE_API_KEY',
    // The watcher owns Retry-After scheduling so broker-first exits keep their 15s cadence.
    max_429_retries: 0,
    request_timeout_ms: finite_number(provider.request_timeout_ms, 10_000),
    snapshot_rate_limiter: create_snapshot_rate_limiter({
      min_interval_ms: Math.max(1_000, finite_number(provider.snapshot_min_interval_ms, 1_000)),
    }),
  });

  if (flag(args.discover) && !flag(args.watch) && !flag(args['execute-simulate'])) {
    const result = quota_summary(await nightwatch.discover_datasets());
    await write_status({ phase: 'discover_ok', provider: { name: 'nightwatch', ...result } });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const watch = flag(args.watch);
  const execute_simulate = flag(args['execute-simulate']);
  const mode = execute_simulate ? 'execute_simulate' : 'dry_run';
  const release_runtime_lock = await acquire_runtime_lock();
  let state = await load_runtime_state();
  state.experiment_manifest = exit_experiment;
  const restored_market_context = Number(state.market_context?.schema_version) === 2
    ? state.market_context
    : {};
  let context_builder = create_junk_gex_market_context({
    samples: restored_market_context.samples,
    bars_1m: restored_market_context.bars_1m,
    spx_anchor_samples: restored_market_context.spx_anchor_samples,
    spy_samples: restored_market_context.spy_samples,
    spy_bars_1m: restored_market_context.spy_bars_1m,
  });
  const flow_context_reader = create_junk_flow_context({
    file_path: flow_events_path,
    policy: {
      max_tail_bytes: finite_number(automated_flow_policy.max_tail_bytes, 512 * 1024),
      max_tail_rows: finite_number(automated_flow_policy.max_tail_rows, 4_000),
      evaluation_window_seconds: flow_windows_seconds.at(-1),
      min_confirming_event_count: finite_number(automated_flow_policy.minimum_events, 2),
      min_large_sweep_premium_usd: finite_number(
        automated_flow_policy.confirmation_min_premium_usd,
        100_000,
      ),
      min_same_strike_event_count: finite_number(automated_flow_policy.minimum_events, 2),
      min_confirming_premium_usd: finite_number(
        automated_flow_policy.confirmation_min_premium_usd,
        100_000,
      ),
      min_confirming_supportive_to_opposite_ratio: finite_number(
        automated_flow_policy.confirming_supportive_to_opposite_ratio,
        2,
      ),
      min_opposite_event_count: finite_number(automated_flow_policy.minimum_events, 2),
      min_opposite_premium_usd: finite_number(automated_flow_policy.conflict_min_premium_usd, 200_000),
      min_opposite_to_supportive_ratio: finite_number(
        automated_flow_policy.conflict_opposite_to_supportive_ratio,
        2,
      ),
    },
  });
  let moomoo_runtime = null;
  let stop_requested = false;
  let last_decision = null;
  let last_error = null;

  const stop = () => { stop_requested = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  async function ensure_moomoo() {
    if (!moomoo_runtime) moomoo_runtime = await create_moomoo_runtime(args);
    return moomoo_runtime;
  }

  async function reset_moomoo() {
    if (!moomoo_runtime) return;
    try { await moomoo_runtime.close(); } catch { /* best effort */ }
    moomoo_runtime = null;
  }

  async function persist_state() {
    state.updated_at = new Date().toISOString();
    await write_json(state_path, state);
    await write_json(experiment_summary_path, summarize_junk_exit_experiment(state));
  }

  function experiment_status() {
    const manifest_conflicts = junk_experiment_manifest_conflicts(state, exit_experiment);
    return {
      manifest: exit_experiment,
      manifest_transition: manifest_conflicts.length > 0 ? {
        status: 'draining_previous_manifest',
        new_entries_blocked: true,
        active_conflicting_cohort_ids: manifest_conflicts
          .map((row) => row.experiment_ledger?.cohort_id)
          .filter(Boolean),
      } : {
        status: 'current',
        new_entries_blocked: false,
        active_conflicting_cohort_ids: [],
      },
      aggregate: summarize_junk_exit_experiment(state),
      daily: daily_experiment_summary(state),
    };
  }

  function provider_wait_ms(at_ms = Date.now()) {
    const blocked_until_ms = Date.parse(state.provider_blocked_until || '');
    return Number.isFinite(blocked_until_ms) ? Math.max(0, blocked_until_ms - at_ms) : 0;
  }

  function apply_provider_backoff(error, at_ms = Date.now()) {
    const retry_after_ms = Math.max(0, finite_number(error?.retry_after_ms, 0));
    if (retry_after_ms <= 0) return 0;
    const blocked_until_ms = at_ms + retry_after_ms;
    const existing_ms = Date.parse(state.provider_blocked_until || '');
    state.provider_blocked_until = new Date(Math.max(
      blocked_until_ms,
      Number.isFinite(existing_ms) ? existing_ms : 0,
    )).toISOString();
    state.provider_retry_after_ms = retry_after_ms;
    return retry_after_ms;
  }

  function ingest_cached_spy_sample(at_ms = Date.now()) {
    if (!moomoo_runtime) return null;
    const snapshot = moomoo_runtime.quote_feed.cachedSnapshots([spy_security])[0] || null;
    if (!snapshot) return null;
    return context_builder.ingest_spy_sample(snapshot, { at_ms });
  }

  async function wait_with_price_sampling(delay_ms) {
    const deadline = Date.now() + Math.max(0, delay_ms);
    while (!stop_requested && Date.now() < deadline) {
      await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())));
      ingest_cached_spy_sample(Date.now());
    }
  }

  async function refresh_quota(force = false) {
    const age = Date.now() - Date.parse(state.quota?.checked_at || '');
    if (!force && Number.isFinite(age) && age < 60 * 60 * 1000) return;
    if (provider_wait_ms() > 0) return;
    try {
      state.quota = quota_summary(await nightwatch.discover_datasets());
      state.quota_error = null;
    } catch (error) {
      state.quota_error = sanitized_error(error);
      apply_provider_backoff(error);
    }
  }

  async function cycle() {
    const cycle_started_at = new Date();
    const ny = ny_context(cycle_started_at);
    if (state.session_date_et !== ny.date_key) {
      state.session_date_et = ny.date_key;
      state.daily_trade_count = 0;
      state.daily_realized_pnl_usd = 0;
      state.last_entry_at = null;
      state.executed_signal_ids = [];
      state.market_context = {};
      state.gex_node_history = [];
      state.contract_audit_cache = {};
      state.broker_recovery = {
        status: 'pending',
        checked_at: null,
        recovered_order_count: 0,
        source_state: state.broker_recovery?.source_state || 'session_reset',
      };
      context_builder = create_junk_gex_market_context();
    }
    const schedule = market_schedule(config.policy, ny);
    let runtime = moomoo_runtime;
    if (state.broker_recovery?.status !== 'complete') {
      runtime = await ensure_moomoo();
      await recover_line_ownership({
        runtime,
        state,
        now: cycle_started_at,
        persist_state,
      });
    }
    const has_active_orders = active_order_rows(state).length > 0;
    if (!schedule.market_open && !has_active_orders && watch) {
      await persist_state();
      await write_status({
        phase: 'idle_market_closed',
        mode,
        process_id: process.pid,
        session_date_et: state.session_date_et,
        market_schedule: schedule,
        quota: state.quota,
        experiment: experiment_status(),
        risk: risk_state(state),
        active_orders: [],
        broker_recovery: state.broker_recovery,
        last_decision: compact_decision(last_decision),
        last_error,
      });
      return { idle: true, delay_ms: 60000 };
    }

    runtime = runtime || await ensure_moomoo();

    const allow_broker_execution = execute_simulate && schedule.market_open;
    const broker_first_reconcile = await reconcile_line_orders({
      runtime,
      state,
      now: new Date(),
      underlying_price_usd: fresh_last_gex_spot(state, new Date()),
      allow_execution: allow_broker_execution,
      persist_state,
      schedule,
    });

    if (!schedule.market_open) {
      await persist_state();
      await write_status({
        phase: 'market_closed_broker_reconcile_only',
        mode,
        process_id: process.pid,
        session_date_et: state.session_date_et,
        market_schedule: schedule,
        quota: state.quota,
        experiment: experiment_status(),
        moomoo: {
          connected: true,
          account: runtime.simulated_account,
          quote_feed: runtime.quote_feed.status(),
        },
        risk: risk_state(state),
        active_orders: active_order_rows(state).map(compact_order),
        broker_recovery: state.broker_recovery,
        reconcile: broker_first_reconcile,
        last_decision: compact_decision(last_decision),
        last_error,
      });
      return { idle: true, delay_ms: 60000 };
    }

    const blocked_ms_before_quota = provider_wait_ms();
    if (blocked_ms_before_quota > 0) {
      await persist_state();
      await write_status({
        phase: 'provider_backoff_broker_reconcile_active',
        mode,
        process_id: process.pid,
        session_date_et: state.session_date_et,
        market_schedule: schedule,
        provider: {
          name: 'nightwatch',
          blocked_until: state.provider_blocked_until,
          retry_after_ms: state.provider_retry_after_ms || null,
        },
        quota: state.quota,
        experiment: experiment_status(),
        risk: risk_state(state),
        active_orders: active_order_rows(state).map(compact_order),
        broker_recovery: state.broker_recovery,
        reconcile: broker_first_reconcile,
        last_decision: compact_decision(last_decision),
        last_error,
      });
      return { idle: false, delay_ms: provider_backoff_cycle_delay(poll_ms, blocked_ms_before_quota) };
    }

    await refresh_quota(false);
    const blocked_ms_after_quota = provider_wait_ms();
    if (blocked_ms_after_quota > 0) {
      await persist_state();
      await write_status({
        phase: 'provider_backoff_broker_reconcile_active',
        mode,
        process_id: process.pid,
        session_date_et: state.session_date_et,
        market_schedule: schedule,
        provider: {
          name: 'nightwatch',
          blocked_until: state.provider_blocked_until,
          retry_after_ms: state.provider_retry_after_ms || null,
        },
        quota: state.quota,
        experiment: experiment_status(),
        risk: risk_state(state),
        active_orders: active_order_rows(state).map(compact_order),
        broker_recovery: state.broker_recovery,
        reconcile: broker_first_reconcile,
        last_decision: compact_decision(last_decision),
        last_error: state.quota_error || null,
      });
      return { idle: false, delay_ms: provider_backoff_cycle_delay(poll_ms, blocked_ms_after_quota) };
    }

    const gex_response = await nightwatch.get_dealer_gex_snapshot(ticker, {
      query: { format: provider.gex_snapshot_format || 'full' },
    });
    const gex_data = gex_response?.data || gex_response || {};
    state.provider_blocked_until = null;
    state.provider_retry_after_ms = null;
    const normalized_gex = normalize_gex_snapshot(gex_response, config.policy?.strategy?.max_nodes);
    state.gex_node_history = [
      ...(state.gex_node_history || []),
      {
        ticker: normalized_gex.ticker,
        snapshot_at: normalized_gex.snapshot_at,
        session_date_et: normalized_gex.session_date_et,
        state: normalized_gex.state,
        spot_usd: normalized_gex.spot_usd,
        strikes: normalized_gex.nodes,
      },
    ].filter((item) => item.snapshot_at).slice(-240);

    const context_build_at = Date.now();
    const heatmap_age = context_build_at - Date.parse(state.heatmap?.fetched_at || '');
    if (!Number.isFinite(heatmap_age) || heatmap_age >= heatmap_poll_ms) {
      try {
        state.heatmap = heatmap_summary(await nightwatch.get_heatmap_snapshot(ticker, {
          query: { format: 'summary' },
        }));
        state.heatmap_error = null;
      } catch (error) {
        state.heatmap_error = sanitized_error(error);
        apply_provider_backoff(error);
      }
    }

    const spy_quote_result = await with_timeout(runtime.quote_feed.getSnapshots([spy_security], {
      orderBookSecurities: [],
    }), 10_000, 'SPY quote snapshot');
    let spy_snapshot = (spy_quote_result.snapshots || [])
      .find((snapshot) => snapshot?.basic?.security?.code === 'SPY') || null;
    let spy_basic = spy_snapshot?.basic || null;
    if (!positive_number(spy_snapshot?.basic?.avgPrice ?? spy_snapshot?.basic?.avg_price)) {
      const direct_spy = normalizeForJson(await with_timeout(
        getSecuritySnapshots(runtime.client, [spy_security]), 10_000, 'direct SPY snapshot',
      ));
      spy_basic = direct_spy?.s2c?.snapshotList?.[0]?.basic || spy_basic;
    }
    const market_context_at = Date.now();
    context_builder.ingest_sample(gex_response, { at_ms: market_context_at });
    if (spy_snapshot) context_builder.ingest_spy_sample(spy_snapshot, { at_ms: market_context_at });
    const market_context = context_builder.build_market_context({
      spx_snapshot: gex_response,
      spy_snapshot,
      spy_basic,
      at_ms: market_context_at,
    });

    const market_reconcile = await reconcile_line_orders({
      runtime,
      state,
      now: new Date(market_context_at),
      underlying_price_usd: market_context.last_price_usd,
      allow_execution: allow_broker_execution,
      persist_state,
      schedule,
    });
    const reconcile = {
      watched: Math.max(broker_first_reconcile.watched, market_reconcile.watched),
      submitted_exits: broker_first_reconcile.submitted_exits + market_reconcile.submitted_exits,
      quote_error: market_reconcile.quote_error || broker_first_reconcile.quote_error || null,
      broker_first: true,
    };

    const strategy_policy = {
      ...(config.policy?.strategy || {}),
      execution_environment: 'simulate_only',
      real_trading_allowed: false,
    };
    const core_decision = evaluate_junk_gex_strategy({
      gex_snapshot: gex_response,
      gex_node_history: state.gex_node_history,
      market_context,
      policy: strategy_policy,
      now_ms: market_context_at,
    });
    const flow_context = flow_context_reader.build_context({
      source_connected: await discord_flow_source_connected(market_context_at),
    });
    let flow_evaluation = {
      decision: 'neutral',
      availability_status: flow_context.availability_status,
      reason_codes: ['no_trade_candidate_for_flow_evaluation'],
    };
    if (core_decision.decision === 'trade' && automated_flow_policy.enabled !== false) {
      try {
        flow_evaluation = flow_context_reader.evaluate_windows({
          candidate_direction: core_decision.direction,
          candidate_spot_usd: core_decision.last_price_usd ?? core_decision.spot_usd,
          candidate_last_price_usd: core_decision.last_price_usd,
          spy_spot_usd: market_context.spy_cur_price_usd,
          candidate: core_decision,
          flow_context,
          windows_seconds: flow_windows_seconds,
        });
      } catch (error) {
        flow_evaluation = {
          decision: 'neutral',
          availability_status: flow_context.availability_status,
          reason_codes: [`flow_evaluation_error_neutral:${sanitized_error(error)}`],
        };
      }
    }
    if (core_decision.decision === 'trade' && automated_flow_policy.enabled === false) {
      flow_evaluation = {
        decision: 'neutral',
        availability_status: flow_context.availability_status,
        reason_codes: ['automated_flow_evidence_disabled'],
      };
    }
    let decision = apply_junk_v3_evidence({
      core_decision,
      heatmap_context: state.heatmap,
      flow_evaluation,
      evidence_policy: config.policy?.evidence_gates || {},
      now_ms: market_context_at,
    });
    const quota_floor = positive_number(provider.quota_entry_safety_floor, 10_000);
    const quota_remaining = finite_number(state.quota?.monthly_remaining);
    const entry_pause_reasons = [];
    if (!schedule.entry_open) entry_pause_reasons.push('outside_calendar_entry_window');
    if (state.broker_recovery?.status !== 'complete') entry_pause_reasons.push('broker_recovery_incomplete');
    if (!experiment_cohorts_allow_new_entry(state)) entry_pause_reasons.push('experiment_previous_cohort_not_flat');
    if (junk_experiment_manifest_conflicts(state, exit_experiment).length > 0) {
      entry_pause_reasons.push('experiment_manifest_transition_draining_previous_cohort');
    }
    if (experiment_unpriced_incident_blocks_new_entry(state)) {
      entry_pause_reasons.push('experiment_unpriced_force_close_requires_manual_reconciliation');
    }
    if (quota_remaining === null) entry_pause_reasons.push('quota_unavailable_entry_block');
    else if (quota_remaining < quota_floor) entry_pause_reasons.push('quota_safety_floor_entry_block');
    if (!market_context.price_action_ready) entry_pause_reasons.push(`price_action_not_ready:${market_context.readiness_reason_code}`);
    if (decision.decision === 'trade' && entry_pause_reasons.length > 0) {
      decision = {
        ...decision,
        decision: 'no_trade',
        action: 'hold',
        reason_codes: [...new Set([...(decision.reason_codes || []), ...entry_pause_reasons])],
      };
    }
    decision = {
      ...decision,
      generated_at: new Date(market_context_at).toISOString(),
      heatmap_context: {
        state: state.heatmap?.state || null,
        generated_at: state.heatmap?.generated_at || null,
        session_date_et: state.heatmap?.session_date_et || null,
        nearest_tested_node_row: nearest_heatmap_row(state.heatmap, decision.tested_node?.strike_usd),
      },
      automated_flow_context: flow_context,
      market_context: {
        ...market_context,
        bars_1m: market_context.bars_1m.slice(-15),
        bars_5m: market_context.bars_5m.slice(-3),
      },
    };
    let prepared_entry_plan = null;
    if (decision.decision === 'trade'
      && open_position_count(state) === 0
      && experiment_cohorts_allow_new_entry(state)) {
      prepared_entry_plan = await prepareZeroDteSimulatedEntry({
        client: runtime.client,
        signal: decision,
        config: runtime.config,
        risk_state: junk_experiment_entry_risk_state(
          risk_state(state),
          exit_experiment,
          daily_experiment_summary(state),
        ),
        now: new Date(market_context_at),
        quote_feed: runtime.quote_feed,
      });
      let contract_audit;
      const cache_key = junk_contract_audit_cache_key({
        signal_id: prepared_entry_plan.signal?.signal_id,
        contract: prepared_entry_plan.contract?.code,
        expiration: prepared_entry_plan.contract?.expiration || prepared_entry_plan.signal?.expiration,
      });
      contract_audit = prepared_entry_plan.gate?.passed && cache_key
        ? read_junk_contract_audit_cache({
          cache: state.contract_audit_cache,
          cache_key,
          now_ms: market_context_at,
        })
        : null;
      if (!contract_audit) {
        try {
          contract_audit = await audit_junk_contract_candidate({
            nightwatch,
            decision,
            entry_plan: prepared_entry_plan,
            policy: contract_audit_policy,
          });
        } catch (error) {
          const audit_failed_at = Date.now();
          apply_provider_backoff(error, audit_failed_at);
          const status = finite_number(error?.status);
          const reason_code = status === 429
            ? 'nightwatch_contract_audit_rate_limited_neutral'
            : (status === 503
              ? 'nightwatch_contract_audit_service_unavailable_neutral'
              : 'nightwatch_contract_audit_request_failed_neutral');
          contract_audit = degraded_junk_contract_audit({
            candidate_contract: prepared_entry_plan.contract?.code,
            source_path: `/v1/options/chain-snapshot/${prepared_entry_plan.signal?.ticker || ticker}`,
            available_at: audit_failed_at,
            reason_code,
            provider_call_count: prepared_entry_plan.gate?.passed ? 1 : 0,
          });
        }
        if (prepared_entry_plan.gate?.passed && cache_key) {
          const stable_assessment = ['confirm', 'veto'].includes(contract_audit.assessment);
          const cache_ttl_ms = stable_assessment
            ? Math.max(60_000, finite_number(contract_audit_policy.setup_cache_ttl_ms, 900_000))
            : Math.max(60_000, finite_number(contract_audit_policy.degraded_cache_ttl_ms, 60_000));
          state.contract_audit_cache = write_junk_contract_audit_cache({
            cache: state.contract_audit_cache,
            cache_key,
            audit: contract_audit,
            now_ms: Date.now(),
            ttl_ms: cache_ttl_ms,
          });
          // Persist before any possible broker submission so a restart cannot
          // burn another unit for the same setup/contract/expiration.
          await persist_state();
        }
      }
      const audited = apply_junk_contract_audit({
        decision,
        entry_plan: prepared_entry_plan,
        audit: contract_audit,
      });
      decision = audited.decision;
      prepared_entry_plan = build_junk_experiment_entry_cohort(
        audited.entry_plan,
        exit_experiment,
        config.policy,
      );
    }
    last_decision = decision;
    await append_json_line(decisions_path, decision);

    if (prepared_entry_plan) {
      let plan = prepared_entry_plan;
      if (plan.gate.passed) {
        const conflict = await broker_contract_conflict(runtime, plan.order?.code);
        if (conflict.conflict) {
          plan = {
            ...plan,
            order_status: 'gate_failed',
            gate: {
              ...plan.gate,
              passed: false,
              reasons: [...new Set([...(plan.gate.reasons || []), ...conflict.reasons])],
            },
          };
        }
      }
      await append_json_line(entry_plans_path, plan);
      if (execute_simulate && plan.gate.passed) {
        const intent = entry_row_from_plan(plan, null, new Date(market_context_at));
        intent.status = 'entry_intent';
        intent.entry_remark = plan.order?.remark || null;
        intent.entry_order_id = null;
        intent.entry_order_id_ex = null;
        intent.entry_submitted_at = new Date(market_context_at).toISOString();
        intent.recovered_from_broker = false;
        intent.entry_order_missing_cycles = 0;
        state.orders[intent.plan_id] = intent;
        state.executed_signal_ids = [...new Set([
          ...(state.executed_signal_ids || []),
          plan.signal.signal_id,
        ])].slice(-1000);
        await persist_state();
        await write_experiment_event('experiment_entry_intent', intent, {
          aggregate_requested_qty: intent.submitted_qty,
          per_line_requested_qty: intent.experiment_ledger?.per_line_entry_qty_requested || null,
          entry_remark: intent.entry_remark,
        });
        let execution;
        try {
          execution = await executeZeroDteSimulatedEntry({
            client: runtime.client,
            config: runtime.config,
            plan,
            now: new Date(market_context_at),
          });
        } catch (error) {
          if (error?.submission_outcome === 'not_submitted') {
            intent.status = 'entry_unfilled_terminal';
            intent.last_error = sanitized_error(error);
            intent.updated_at = new Date().toISOString();
            await persist_state();
            await write_trade_event('entry_preflight_failed_not_submitted', {
              ...experiment_event_fields(intent),
              plan_id: intent.plan_id,
              signal_id: intent.signal_id,
              code: intent.code,
              submission_phase: error.submission_phase || null,
              error: intent.last_error,
            });
            execution = null;
          } else {
            intent.status = 'entry_submission_unknown';
            intent.last_error = sanitized_error(error);
            intent.updated_at = new Date().toISOString();
            await persist_state();
            throw error;
          }
        }
        if (execution?.order_status === 'submitted_simulation' && has_broker_order_identity(execution.execution)) {
          intent.status = 'entry_submitted';
          apply_broker_order_identity(intent, 'entry', execution.execution);
          intent.entry_submitted_at = execution.execution.submitted_at;
          intent.updated_at = new Date().toISOString();
          recompute_session_risk(state);
          await persist_state();
          await append_json_line(entry_plans_path, execution);
          await write_trade_event('entry_order_submitted', {
            ...experiment_event_fields(intent),
            plan_id: intent.plan_id,
            signal_id: intent.signal_id,
            code: intent.code,
            expiration: intent.expiration,
            qty: intent.submitted_qty,
            limit_price: intent.entry_limit_price,
            order_id: intent.entry_order_id,
            order_id_ex: intent.entry_order_id_ex,
            direction: intent.direction,
            invalidation_price: intent.invalidation_price,
            target_price: intent.target_price,
            paper_equity_usd: intent.experiment_ledger
              ? exit_experiment.total_paper_equity_usd
              : (config.policy?.position_sizing?.paper_equity_usd || 10000),
            paper_equity_usd_per_line: intent.experiment_ledger ? 10000 : null,
          });
          await write_experiment_event('experiment_entry_order_submitted', intent, {
            aggregate_requested_qty: intent.submitted_qty,
            per_line_requested_qty: intent.experiment_ledger?.per_line_entry_qty_requested || null,
            order_id: intent.entry_order_id,
            order_id_ex: intent.entry_order_id_ex,
          });
        } else if (execution?.order_status === 'submitted_simulation') {
          intent.status = 'entry_submission_unknown';
          intent.last_error = 'entry_submission_accepted_without_broker_order_identity';
          intent.updated_at = new Date().toISOString();
          await persist_state();
          await append_json_line(entry_plans_path, execution);
        } else if (execution) {
          intent.status = 'entry_unfilled_terminal';
          intent.last_error = execution.execution?.reason || 'entry_not_submitted';
          intent.updated_at = new Date().toISOString();
          await persist_state();
          await append_json_line(entry_plans_path, execution);
        }
      }
    }

    state.market_context = context_builder.export_state({ at_ms: Date.now() });
    state.last_gex = {
      snapshot_at: gex_data.snapshot_at || null,
      session_date_et: gex_data.session_date_et || null,
      state: gex_data.state || null,
      spot_usd: finite_number(gex_data.spot_usd),
      data_freshness_seconds: finite_number(gex_response?._meta?.data_freshness_seconds),
    };
    await persist_state();
    await write_status({
      phase: watch ? (execute_simulate ? 'watching_simulation' : 'watching_plan') : 'cycle_complete',
      mode,
      process_id: process.pid,
      session_date_et: state.session_date_et,
      market_schedule: schedule,
      provider: {
        name: 'nightwatch',
        last_gex: state.last_gex,
        heatmap: state.heatmap,
        heatmap_error: state.heatmap_error || null,
      },
      automated_flow: {
        availability_status: flow_context.availability_status,
        source_connected: flow_context.source_connected,
        accepted_event_count: flow_context.accepted_event_count,
        isolated_event_count: flow_context.isolated_event_count,
        deduplicated_event_count: flow_context.deduplicated_event_count,
        isolation_reason_counts: flow_context.isolation_reason_counts,
        windows: flow_context.windows,
      },
      quota: state.quota,
      experiment: experiment_status(),
      moomoo: {
        connected: true,
        account: runtime.simulated_account,
        quote_feed: runtime.quote_feed.status(),
      },
      market_context: {
        price_action_source: market_context.price_action_source,
        price_action_ready: market_context.price_action_ready,
        readiness_reason_code: market_context.readiness_reason_code,
        last_price_usd: market_context.last_price_usd,
        vwap_usd: market_context.vwap_usd,
        closed_bars_1m: market_context.bars_1m.length,
        closed_bars_5m: market_context.bars_5m.length,
        latest_closed_bar: market_context.bars_1m.at(-1) || null,
        latest_closed_bar_5m: market_context.bars_5m.at(-1) || null,
      },
      risk: risk_state(state),
      active_orders: active_order_rows(state).map(compact_order),
      broker_recovery: state.broker_recovery,
      reconcile,
      last_decision: compact_decision(last_decision),
      last_error: null,
    });
    last_error = null;
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      phase: execute_simulate ? 'watching_simulation' : 'watching_plan',
      gex_state: gex_data.state || null,
      spot_usd: finite_number(gex_data.spot_usd),
      decision: decision.decision,
      reason_codes: decision.reason_codes,
      closed_bars_1m: market_context.bars_1m.length,
      active_orders: active_order_rows(state).length,
    }));
    return { idle: false, delay_ms: poll_ms };
  }

  await write_status({
    phase: 'starting',
    mode,
    process_id: process.pid,
    quota: state.quota,
    experiment: experiment_status(),
    risk: risk_state(state),
  });

  try {
    do {
      const cycle_started_at = Date.now();
      let delay_ms = poll_ms;
      try {
        const result = await cycle();
        delay_ms = result.delay_ms;
      } catch (error) {
        last_error = sanitized_error(error);
        const retry_after_ms = apply_provider_backoff(error);
        if (error?.name !== 'NightwatchRestError') await reset_moomoo();
        await persist_state();
        await write_status({
          phase: watch ? 'degraded_retrying' : 'cycle_failed',
          mode,
          process_id: process.pid,
          quota: state.quota,
          experiment: experiment_status(),
          risk: risk_state(state),
          active_orders: active_order_rows(state).map(compact_order),
          broker_recovery: state.broker_recovery,
          provider: {
            name: 'nightwatch',
            blocked_until: state.provider_blocked_until || null,
            retry_after_ms: retry_after_ms || null,
          },
          last_decision: compact_decision(last_decision),
          last_error,
        });
        if (!watch) throw error;
        delay_ms = poll_ms;
      }
      if (!watch || stop_requested) break;
      await wait_with_price_sampling(Math.max(0, delay_ms - (Date.now() - cycle_started_at)));
    } while (!stop_requested);
  } finally {
    await reset_moomoo();
    await release_runtime_lock();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }

  if (stop_requested) {
    await write_status({
      phase: 'stopped',
      mode,
      process_id: process.pid,
      quota: state.quota,
      experiment: experiment_status(),
      risk: risk_state(state),
      active_orders: active_order_rows(state).map(compact_order),
      last_decision: compact_decision(last_decision),
      last_error,
    });
  }
  return { state, last_decision };
}

const invoked_path = process.argv[1] ? path.resolve(process.argv[1]) : '';
const is_main = invoked_path
  && path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === invoked_path.toLowerCase();
if (is_main) {
  run_zero_dte_line().catch(async (error) => {
    const message = sanitized_error(error);
    try {
      await write_status({ phase: 'fatal', mode: 'unknown', last_error: message });
    } catch {
      // Preserve the original failure.
    }
    console.error(message);
    process.exitCode = 1;
  });
}
