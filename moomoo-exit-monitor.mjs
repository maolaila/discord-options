import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_ROOT,
  QOT_MARKET_US_SECURITY,
  TRD_ENV_REAL,
  TRD_ENV_SIMULATE,
  buildOptionExecutionQuote,
  connectMoomoo,
  createMoomooQuoteFeed,
  ensureDir,
  fetchMoomooAccounts,
  fetchOrderFillList,
  fetchOrderList,
  fetchPositionList,
  loadMoomooConfig,
  maskId,
  moomooUnderlyingCode,
  normalizeForJson,
  parseCliArgs,
  placeLimitSellOrder,
  selectConfiguredUsRealAccount,
  selectSimulatedUsOptionAccount,
} from './moomoo-opend.mjs';
import {
  appendTradeJournalEvent,
  buildExitJournalPayload,
} from './trade-journal.mjs';

const args = parseCliArgs();
const logsDir = path.join(PROJECT_ROOT, 'logs');
const executionsPath = path.join(logsDir, 'moomoo-executions.ndjson');
const exitOrdersPath = path.join(logsDir, 'moomoo-exit-orders.ndjson');
const statePath = path.join(logsDir, 'moomoo-exit-state.json');
const statusPath = path.join(logsDir, 'moomoo-exit-status.json');
const regularSessionStartMinutes = 9 * 60 + 30;
const regularSessionEndMinutes = 16 * 60;
const defaultCloseExitStartMinutes = 15 * 60 + 45;
const defaultForceCloseExitStartMinutes = 15 * 60 + 55;

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const parsed = numeric(value);
    if (parsed !== null && parsed > 0) return parsed;
  }
  return null;
}

function readNdjson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function appendJsonLine(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  await fsp.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function loadState() {
  if (!fs.existsSync(statePath)) return { orders: {} };
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { orders: {} };
  }
}

async function writeState(state) {
  await ensureDir(path.dirname(statePath));
  await fsp.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function writeStatus(payload) {
  await ensureDir(path.dirname(statusPath));
  await fsp.writeFile(statusPath, `${JSON.stringify({ updated_at: new Date().toISOString(), ...payload }, null, 2)}\n`, 'utf8');
}

function submittedBuyPlans(mode) {
  const seen = new Map();
  for (const plan of readNdjson(executionsPath)) {
    const orderIDEx = String(plan.execution?.response?.s2c?.orderIDEx || '');
    if (!orderIDEx) continue;
    if (plan.mode !== mode || plan.order_status !== 'submitted') continue;
    if (plan.order?.side !== 'BUY_TO_OPEN') continue;
    seen.set(orderIDEx, plan);
  }
  return [...seen.entries()].map(([orderIDEx, plan]) => ({ orderIDEx, plan }));
}

function byOrderIDEx(rows) {
  const out = new Map();
  for (const row of rows || []) {
    const id = String(row.orderIDEx || '');
    if (id) out.set(id, row);
  }
  return out;
}

function fillSummaryByOrderIDEx(fills) {
  const out = new Map();
  for (const fill of fills || []) {
    const id = String(fill.orderIDEx || '');
    if (!id) continue;
    const current = out.get(id) || { buyQty: 0, buyValue: 0, sellQty: 0, sellValue: 0, fills: [] };
    const qty = Number(fill.qty || 0);
    const price = Number(fill.price || 0);
    if (Number(fill.trdSide) === 1) {
      current.buyQty += qty;
      current.buyValue += qty * price;
    } else if (Number(fill.trdSide) === 2) {
      current.sellQty += qty;
      current.sellValue += qty * price;
    }
    current.fills.push(normalizeForJson(fill));
    out.set(id, current);
  }
  return out;
}

async function safeOrderFillList(client, config) {
  try {
    return normalizeForJson((await fetchOrderFillList(client, config)).s2c?.orderFillList || []);
  } catch (error) {
    const msg = String(error?.retMsg || error?.message || error || '');
    if (msg.includes('模拟交易不支持成交数据') || msg.includes('simulation') || msg.includes('simulate')) {
      return [];
    }
    throw error;
  }
}

export function nyParts(date = new Date()) {
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
  const out = {};
  for (const part of parts) out[part.type] = part.value;
  return {
    weekday: out.weekday,
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour === '24' ? '0' : out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

function isWeekday(parts) {
  return !['Sat', 'Sun'].includes(parts.weekday);
}

function parseEtTimeToMinutes(value, fallback) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return fallback;
  }
  return hour * 60 + minute;
}

function formatEtMinutes(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function nySessionMinutes(date = new Date()) {
  const p = nyParts(date);
  return { parts: p, minutes: p.hour * 60 + p.minute };
}

function nyDateKey(date = new Date()) {
  const p = nyParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function isRegularSessionNow(date = new Date()) {
  const { parts, minutes } = nySessionMinutes(date);
  if (!isWeekday(parts)) return false;
  return minutes >= regularSessionStartMinutes && minutes <= regularSessionEndMinutes;
}

export function closeExitTrigger(rules = {}, date = new Date()) {
  if (!rules.exit_before_regular_session_close && !rules.no_overnight_holding) return null;
  const { parts, minutes } = nySessionMinutes(date);
  if (!isWeekday(parts)) return null;
  const closeStart = parseEtTimeToMinutes(rules.close_exit_start_time_et, defaultCloseExitStartMinutes);
  const forceStartRaw = parseEtTimeToMinutes(rules.force_close_exit_start_time_et, defaultForceCloseExitStartMinutes);
  const forceStart = Math.max(closeStart, forceStartRaw);
  if (minutes < closeStart || minutes > regularSessionEndMinutes) return null;
  return {
    reason: 'exit_before_regular_session_close',
    line: null,
    underlying_price: null,
    close_exit_phase: minutes >= forceStart ? 'force' : 'standard',
    close_exit_start_time_et: formatEtMinutes(closeStart),
    force_close_exit_start_time_et: formatEtMinutes(forceStart),
  };
}

function mergeExitRules(plan, config) {
  const optionRules = plan.order?.option_exit_rules || {};
  const stockRules = plan.order?.underlying_exit_rules || {};
  return {
    ...(config?.policy?.exit_rules || {}),
    ...stockRules,
    option_price_exit_enabled: stockRules.option_price_exit_enabled ?? true,
    option_stop_loss_pct: stockRules.option_stop_loss_pct
      ?? optionRules.stop_loss_return_pct
      ?? optionRules.stop_loss_move_pct
      ?? config?.optionExitStopLossPct
      ?? config?.optionStopLossPct,
    option_take_profit_pct: stockRules.option_take_profit_pct
      ?? optionRules.take_profit_return_pct
      ?? optionRules.take_profit_move_pct
      ?? config?.optionExitTakeProfitPct
      ?? config?.optionTakeProfitPct,
    exit_before_regular_session_close: stockRules.exit_before_regular_session_close
      ?? optionRules.exit_before_regular_session_close
      ?? config?.policy?.exit_rules?.exit_before_regular_session_close
      ?? true,
    close_exit_start_time_et: stockRules.close_exit_start_time_et
      ?? optionRules.close_exit_start_time_et
      ?? config?.closeExitStartTimeEt,
    force_close_exit_start_time_et: stockRules.force_close_exit_start_time_et
      ?? optionRules.force_close_exit_start_time_et
      ?? config?.forceCloseExitStartTimeEt,
    no_overnight_holding: stockRules.no_overnight_holding
      ?? optionRules.no_overnight_holding
      ?? config?.policy?.exit_rules?.no_overnight_holding
      ?? true,
  };
}

export function exitTrigger(plan, underlyingPrice, opts = {}) {
  const now = opts.now || new Date();
  const rules = mergeExitRules(plan, opts.config);
  const closeTrigger = opts.skipCloseExit ? null : closeExitTrigger(rules, now);
  if (!isRegularSessionNow(now)) return null;

  const optionTrigger = optionPriceExitTrigger(plan, opts.optionQuote, opts.entryOptionPrice, opts);
  const direction = String(plan.signal?.direction || '').toLowerCase();
  const entry = numeric(rules.entry_price ?? plan.underlying_quote?.selected_entry_price ?? plan.signal?.stock_entry);
  const target = numeric(rules.signal_stock_target ?? plan.signal?.stock_target);
  const stop = numeric(rules.signal_stock_stop ?? plan.signal?.stock_stop);
  const stopMovePct = numeric(rules.stop_loss_move_pct) ?? 20;
  const takeMovePct = numeric(rules.take_profit_move_pct) ?? 50;
  const price = numeric(underlyingPrice);
  const useSignalStockLines = rules.use_signal_stock_lines !== false;
  if (price === null || entry === null || !direction) return optionTrigger || closeTrigger;

  if (useSignalStockLines && direction === 'bull') {
    if (target !== null && price >= target) return { reason: 'signal_stock_target', line: target, underlying_price: price };
    if (stop !== null && price <= stop) return { reason: 'signal_stock_stop', line: stop, underlying_price: price };
    if (price >= entry * (1 + takeMovePct / 100)) return { reason: 'underlying_50pct_take_profit', line: entry * (1 + takeMovePct / 100), underlying_price: price };
    if (price <= entry * (1 - stopMovePct / 100)) return { reason: 'underlying_20pct_stop_loss', line: entry * (1 - stopMovePct / 100), underlying_price: price };
  } else if (useSignalStockLines && direction === 'bear') {
    if (target !== null && price <= target) return { reason: 'signal_stock_target', line: target, underlying_price: price };
    if (stop !== null && price >= stop) return { reason: 'signal_stock_stop', line: stop, underlying_price: price };
    if (price <= entry * (1 - takeMovePct / 100)) return { reason: 'underlying_50pct_take_profit', line: entry * (1 - takeMovePct / 100), underlying_price: price };
    if (price >= entry * (1 + stopMovePct / 100)) return { reason: 'underlying_20pct_stop_loss', line: entry * (1 + stopMovePct / 100), underlying_price: price };
  }

  if (optionTrigger) return optionTrigger;
  if (closeTrigger) {
    return { ...closeTrigger, underlying_price: price };
  }
  return null;
}

function optionReturnPct(entryPrice, exitPrice) {
  const entry = numeric(entryPrice);
  const exit = numeric(exitPrice);
  if (entry === null || entry <= 0 || exit === null) return null;
  return Number(((exit - entry) / entry * 100).toFixed(4));
}

export function optionPriceExitTrigger(plan, optionQuote, entryOptionPrice, opts = {}) {
  const rules = mergeExitRules(plan, opts.config);
  if (rules.option_price_exit_enabled === false) return null;
  const entry = numeric(entryOptionPrice);
  const current = numeric(optionQuote?.sell_estimate_price ?? optionQuote?.bid);
  if (entry === null || entry <= 0 || current === null || current <= 0) return null;

  const stopPct = numeric(rules.option_stop_loss_pct ?? opts.config?.optionExitStopLossPct) ?? 20;
  const takePct = numeric(rules.option_take_profit_pct ?? opts.config?.optionExitTakeProfitPct) ?? 50;
  const stopLine = entry * (1 - stopPct / 100);
  const takeLine = entry * (1 + takePct / 100);
  if (current <= stopLine) {
    return {
      reason: `option_${pctToken(stopPct)}pct_stop_loss`,
      line: Number(stopLine.toFixed(4)),
      option_price: current,
      entry_option_price: entry,
      option_stop_loss_pct: stopPct,
    };
  }
  if (current >= takeLine) {
    return {
      reason: `option_${pctToken(takePct)}pct_take_profit`,
      line: Number(takeLine.toFixed(4)),
      option_price: current,
      entry_option_price: entry,
      option_take_profit_pct: takePct,
    };
  }
  return null;
}

function pctToken(value) {
  const parsed = numeric(value);
  if (parsed === null) return 'unknown';
  return String(parsed).replace('.', 'p');
}

function decimalPlaces(value) {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot >= 0 ? Math.min(6, text.length - dot - 1) : 0;
}

function roundDownToTick(value, tick) {
  const normalizedTick = Number.isFinite(tick) && tick > 0 ? tick : 0.01;
  const decimals = Math.max(2, decimalPlaces(normalizedTick));
  return Number((Math.floor((value / normalizedTick) + 1e-9) * normalizedTick).toFixed(decimals));
}

export function sellLimitPriceFromQuote(quoteModel, trigger = null) {
  const bid = numeric(quoteModel.bid);
  if (trigger?.close_exit_phase === 'force' && bid !== null && bid > 0) {
    const tick = numeric(quoteModel.tick) || 0.01;
    const spreadAbs = numeric(quoteModel.spread_abs) || 0;
    const extraBuffer = Math.max(tick * 2, spreadAbs * 0.5);
    return Math.max(tick, roundDownToTick(bid - extraBuffer, tick));
  }
  if (Number.isFinite(quoteModel.sell_estimate_price) && quoteModel.sell_estimate_price > 0) return quoteModel.sell_estimate_price;
  if (Number.isFinite(quoteModel.bid) && quoteModel.bid > 0) return quoteModel.bid;
  return null;
}

export function exitOrderClosesPosition({ expectedExitQty, exitFilledQty, position }) {
  const expected = numeric(expectedExitQty) ?? 0;
  const exited = numeric(exitFilledQty) ?? 0;
  if (expected > 0 && exited >= expected) return true;

  const positionQty = numeric(position?.qty);
  return position && positionQty !== null && positionQty <= 0;
}

function isTerminalUnfilledOrderStatus(status) {
  return [3, 15, 21, 22, 23].includes(Number(status));
}

function isTerminalExitOrderStatus(status) {
  return [3, 14, 15, 21, 22, 23, 24].includes(Number(status));
}

export function carryoverCloseExitTrigger(stateRow, now = new Date()) {
  if (stateRow?.status === 'controlled_overnight_hold') {
    const holdDate = stateRow.controlled_overnight_trade_date;
    if (holdDate && holdDate === nyDateKey(now)) return null;
    const closeTrigger = closeExitTrigger({
      exit_before_regular_session_close: true,
      no_overnight_holding: true,
      close_exit_start_time_et: stateRow.close_exit_start_time_et
        ?? stateRow.controlled_overnight?.close_exit_start_time_et
        ?? '15:45',
      force_close_exit_start_time_et: stateRow.force_close_exit_start_time_et
        ?? stateRow.controlled_overnight?.force_close_exit_start_time_et
        ?? '15:55',
    }, now);
    if (!closeTrigger) return null;
    return {
      ...closeTrigger,
      reason: 'controlled_overnight_next_day_exit',
      original_reason: closeTrigger.reason,
      controlled_overnight_trade_date: holdDate ?? null,
    };
  }

  const previousTrigger = stateRow?.exit_trigger || stateRow?.last_trigger;
  if (previousTrigger?.reason !== 'exit_before_regular_session_close') return null;
  if (!isRegularSessionNow(now)) return null;
  return {
    reason: 'carryover_close_exit_retry',
    original_reason: previousTrigger.reason,
    line: null,
    underlying_price: null,
    close_exit_phase: 'force',
    close_exit_start_time_et: previousTrigger.close_exit_start_time_et ?? null,
    force_close_exit_start_time_et: previousTrigger.force_close_exit_start_time_et ?? null,
  };
}

function activeControlledOvernightCount(state) {
  return Object.values(state?.orders || {}).filter((row) => {
    if (row?.status !== 'controlled_overnight_hold') return false;
    const remaining = numeric(row.remaining_qty) ?? numeric(row.can_sell_qty) ?? 0;
    return remaining > 0;
  }).length;
}

function expirationDte(plan, now = new Date()) {
  const expiration = String(plan?.signal?.expiration || plan?.contract?.strike_time || '').slice(0, 10);
  const match = expiration.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const expiryUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const p = nyParts(now);
  const todayUtc = Date.UTC(p.year, p.month - 1, p.day);
  return Math.round((expiryUtc - todayUtc) / 86400000);
}

function controlledOvernightSettings(rules) {
  const settings = rules.controlled_overnight || {};
  return {
    enabled: settings.enabled === true || rules.controlled_overnight_enabled === true,
    maxPositions: Math.max(0, numeric(settings.max_positions ?? rules.controlled_overnight_max_positions) ?? 0),
    minDte: numeric(settings.min_dte ?? rules.controlled_overnight_min_dte) ?? 5,
    maxLossPct: numeric(settings.max_loss_pct ?? rules.controlled_overnight_max_loss_pct) ?? 10,
    nextDayForceExit: settings.next_day_force_exit !== false,
    nextDayExitTiming: settings.next_day_exit_timing || 'close_window',
  };
}

export function controlledOvernightHoldDecision({
  plan,
  stateRow = {},
  trigger,
  optionQuote,
  entryOptionPrice,
  config,
  overnightHeldCount = 0,
  now = new Date(),
} = {}) {
  if (trigger?.reason !== 'exit_before_regular_session_close') return null;
  if (stateRow.status === 'controlled_overnight_hold') return null;

  const rules = mergeExitRules(plan || {}, config);
  const settings = controlledOvernightSettings(rules);
  if (!settings.enabled) return null;
  if (settings.nextDayForceExit !== true) return null;
  if (overnightHeldCount >= settings.maxPositions) return null;

  const dte = expirationDte(plan, now);
  if (dte === null || dte < settings.minDte) return null;

  const current = numeric(optionQuote?.sell_estimate_price ?? optionQuote?.bid);
  const optionReturn = optionReturnPct(entryOptionPrice, current);
  if (optionReturn === null) return null;
  if (optionReturn < -settings.maxLossPct) return null;

  return {
    reason: 'controlled_overnight_hold',
    original_reason: trigger.reason,
    line: null,
    underlying_price: trigger.underlying_price ?? null,
    close_exit_phase: trigger.close_exit_phase ?? null,
    controlled_overnight_trade_date: nyDateKey(now),
    controlled_overnight_max_positions: settings.maxPositions,
    controlled_overnight_min_dte: settings.minDte,
    controlled_overnight_max_loss_pct: settings.maxLossPct,
    close_exit_start_time_et: rules.close_exit_start_time_et ?? null,
    force_close_exit_start_time_et: rules.force_close_exit_start_time_et ?? null,
    next_day_exit_timing: settings.nextDayExitTiming,
    dte,
    option_price: current,
    entry_option_price: numeric(entryOptionPrice),
    option_return_pct: optionReturn,
    next_day_force_exit: true,
  };
}

function isSameDayControlledOvernightHold(stateRow, now = new Date()) {
  return stateRow?.status === 'controlled_overnight_hold'
    && stateRow.controlled_overnight_trade_date === nyDateKey(now);
}

function transientPollError(error) {
  const message = error?.message || String(error);
  if (message.includes('频率太高')) return { kind: 'rate_limited', cooldownSeconds: 30, message };
  if (message.toLowerCase().includes('timeout')) return { kind: 'timeout', cooldownSeconds: 10, message };
  return null;
}

async function ensureSimAccount(client, config) {
  const accounts = await fetchMoomooAccounts(client);
  const account = selectSimulatedUsOptionAccount(accounts);
  if (!account) throw new Error('No simulated US options account found.');
  config.trdEnv = TRD_ENV_SIMULATE;
  config.accId = String(account.accID || '');
  return {
    accID: maskId(account.accID),
    trdEnv: account.trdEnv,
    simAccType: account.simAccType,
    trdMarketAuthList: account.trdMarketAuthList || [],
  };
}

function getMode(config) {
  if (args['execute-real']) {
    throw new Error('Options exit monitor is simulation-only. Use ATR stop for real-account stock exits.');
  }
  config.trdEnv = TRD_ENV_SIMULATE;
  return 'execute_simulate';
}

async function ensureTradingAccount(client, config, mode) {
  if (mode === 'execute_simulate') {
    return {
      mode,
      account: await ensureSimAccount(client, config),
    };
  }
  const accounts = await fetchMoomooAccounts(client);
  const account = selectConfiguredUsRealAccount(accounts, config);
  if (!account) {
    throw new Error('Configured real US trading account was not found or is not authorized for the US market. Check MOOMOO_ACC_ID with npm run moomoo:check.');
  }
  return {
    mode,
    account: {
      accID: maskId(account.accID),
      trdEnv: account.trdEnv,
      trdMarketAuthList: account.trdMarketAuthList || [],
      accType: account.accType,
      jpAccType: account.jpAccType || [],
    },
  };
}

async function processOnce(client, config, state, quoteFeed, mode) {
  const plans = submittedBuyPlans(mode);
  const orderList = normalizeForJson((await fetchOrderList(client, config)).s2c?.orderList || []);
  const fillList = await safeOrderFillList(client, config);
  const positionList = normalizeForJson((await fetchPositionList(client, config)).s2c?.positionList || []);
  const ordersById = byOrderIDEx(orderList);
  const fillsById = fillSummaryByOrderIDEx(fillList);
  let submittedExits = 0;
  let watched = 0;
  let controlledOvernightHeld = activeControlledOvernightCount(state);

  for (const { orderIDEx, plan } of plans) {
    const stateRow = state.orders[orderIDEx] || {};
    if (stateRow.status === 'closed') continue;

    const order = ordersById.get(orderIDEx);
    const fills = fillsById.get(orderIDEx);
    const code = plan.order?.code;
    const position = positionList.find((item) => String(item.code || '') === String(code));
    const filledQty = firstPositiveNumber(
      order?.fillQty,
      fills?.buyQty,
      position?.qty,
      position?.canSellQty,
      stateRow.filled_qty,
    ) ?? 0;
    const fillAvgPrice = firstPositiveNumber(
      order?.fillAvgPrice,
      fills?.buyQty ? fills.buyValue / fills.buyQty : null,
      stateRow.fill_avg_price,
      position?.averageCostPrice,
      position?.dilutedCostPrice,
      position?.costPrice,
    );

    if (stateRow.status === 'exit_submitted' || stateRow.status === 'exit_waiting_fill') {
      const exitOrder = ordersById.get(String(stateRow.exit_order_id_ex || ''));
      const exitFilledQty = numeric(exitOrder?.fillQty) ?? 0;
      const exitFillAvgPrice = numeric(exitOrder?.fillAvgPrice) ?? numeric(stateRow.exit_price);
      const canSellQty = numeric(position?.canSellQty) ?? 0;
      const expectedExitQty = numeric(stateRow.exit_qty) ?? 0;
      let nextState = {
        ...stateRow,
        exit_order_status: exitOrder?.orderStatus ?? null,
        exit_filled_qty: exitFilledQty,
        exit_fill_avg_price: exitFillAvgPrice,
        can_sell_qty: canSellQty,
        updated_at: new Date().toISOString(),
      };

      if (exitFilledQty > 0 && !stateRow.exit_fill_logged) {
        await appendTradeJournalEvent(
          'exit_order_filled',
          buildExitJournalPayload({
            plan,
            config,
            sourceBuyOrderIDEx: orderIDEx,
            lifecycleStatus: 'exit_filled',
            brokerOrder: normalizeForJson(order || null),
            fills: normalizeForJson(fills || null),
            position: normalizeForJson(position || null),
            filledQty,
            fillAvgPrice,
            remainingQty: Math.max(0, Math.floor(filledQty - exitFilledQty)),
            canSellQty,
            exitOrder: {
              side: 'SELL_TO_CLOSE',
              code,
              qty: exitFilledQty,
              price: exitFillAvgPrice,
              price_basis: 'broker_fill_avg_or_submitted_limit',
              order_id_ex: stateRow.exit_order_id_ex,
            },
            state: nextState,
            extra: {
              exit_broker_order: normalizeForJson(exitOrder || null),
            },
          }),
        );
        nextState.exit_fill_logged = true;
      }

      const fullyExited = exitOrderClosesPosition({ expectedExitQty, exitFilledQty, position });
      if (fullyExited) {
        nextState = { ...nextState, status: 'closed', updated_at: new Date().toISOString() };
        if (!stateRow.closed_logged) {
          await appendTradeJournalEvent(
            'position_closed',
            buildExitJournalPayload({
              plan,
              config,
              sourceBuyOrderIDEx: orderIDEx,
              lifecycleStatus: 'closed',
              brokerOrder: normalizeForJson(order || null),
              fills: normalizeForJson(fills || null),
              position: normalizeForJson(position || null),
              filledQty,
              fillAvgPrice,
              remainingQty: 0,
              canSellQty,
              exitOrder: {
                side: 'SELL_TO_CLOSE',
                code,
                qty: exitFilledQty || expectedExitQty,
                price: exitFillAvgPrice,
                price_basis: 'broker_fill_avg_or_submitted_limit',
                order_id_ex: stateRow.exit_order_id_ex,
              },
              state: nextState,
              extra: {
                exit_broker_order: normalizeForJson(exitOrder || null),
              },
            }),
          );
          nextState.closed_logged = true;
        }
      } else if (isTerminalExitOrderStatus(exitOrder?.orderStatus)) {
        nextState = {
          ...nextState,
          status: 'monitoring',
          exit_terminal_status: exitOrder?.orderStatus ?? null,
          exit_retry_after_terminal: true,
          updated_at: new Date().toISOString(),
        };
        await appendTradeJournalEvent(
          'exit_order_terminal_retry_pending',
          buildExitJournalPayload({
            plan,
            config,
            sourceBuyOrderIDEx: orderIDEx,
            lifecycleStatus: 'exit_retry_pending',
            brokerOrder: normalizeForJson(order || null),
            fills: normalizeForJson(fills || null),
            position: normalizeForJson(position || null),
            filledQty,
            fillAvgPrice,
            remainingQty: Math.max(0, Math.floor(filledQty - exitFilledQty)),
            canSellQty,
            exitOrder: {
              side: 'SELL_TO_CLOSE',
              code,
              qty: expectedExitQty,
              price: numeric(stateRow.exit_price),
              price_basis: 'terminal_unfilled_submitted_limit',
              order_id_ex: stateRow.exit_order_id_ex,
            },
            state: nextState,
            extra: {
              exit_broker_order: normalizeForJson(exitOrder || null),
            },
          }),
        );
      } else {
        nextState = { ...nextState, status: 'exit_waiting_fill', updated_at: new Date().toISOString() };
        const changed = stateRow.exit_order_status !== nextState.exit_order_status
          || stateRow.exit_filled_qty !== nextState.exit_filled_qty
          || stateRow.status !== nextState.status;
        if (changed) {
          await appendTradeJournalEvent(
            'exit_order_waiting_fill',
            buildExitJournalPayload({
              plan,
              config,
              sourceBuyOrderIDEx: orderIDEx,
              lifecycleStatus: 'exit_waiting_fill',
              brokerOrder: normalizeForJson(order || null),
              fills: normalizeForJson(fills || null),
              position: normalizeForJson(position || null),
              filledQty,
              fillAvgPrice,
              remainingQty: Math.max(0, Math.floor(filledQty - exitFilledQty)),
              canSellQty,
              exitOrder: {
                side: 'SELL_TO_CLOSE',
                code,
                qty: expectedExitQty,
                price: numeric(stateRow.exit_price),
                price_basis: 'submitted_limit',
                order_id_ex: stateRow.exit_order_id_ex,
              },
              state: nextState,
              extra: {
                exit_broker_order: normalizeForJson(exitOrder || null),
              },
            }),
          );
        }
      }

      state.orders[orderIDEx] = nextState;
      continue;
    }

    if (!filledQty || filledQty <= 0) {
      const status = isTerminalUnfilledOrderStatus(order?.orderStatus) ? 'buy_not_filled_terminal' : 'waiting_buy_fill';
      const nextState = {
        ...stateRow,
        status,
        code: plan.order?.code,
        submitted_qty: plan.order?.qty,
        order_status: order?.orderStatus ?? null,
        updated_at: new Date().toISOString(),
      };
      const changed = stateRow.status !== nextState.status || stateRow.order_status !== nextState.order_status;
      state.orders[orderIDEx] = nextState;
      if (changed) {
        await appendTradeJournalEvent(
          status === 'buy_not_filled_terminal' ? 'buy_order_terminal_unfilled' : 'buy_order_waiting_fill',
          buildExitJournalPayload({
            plan,
            config,
            sourceBuyOrderIDEx: orderIDEx,
            lifecycleStatus: status,
            brokerOrder: normalizeForJson(order || null),
            fills: normalizeForJson(fills || null),
            filledQty,
            fillAvgPrice,
            state: nextState,
          }),
        );
      }
      continue;
    }

    const canSellQty = numeric(position?.canSellQty) ?? 0;
    const sellFilledQty = fills?.sellQty || 0;
    const remainingQty = Math.max(0, Math.floor(filledQty - sellFilledQty));
    const exitQty = Math.min(remainingQty, Math.floor(canSellQty));

    let nextState = {
      ...stateRow,
      code,
      filled_qty: filledQty,
      fill_avg_price: fillAvgPrice,
      remaining_qty: remainingQty,
      can_sell_qty: canSellQty,
      updated_at: new Date().toISOString(),
    };
    if (!stateRow.buy_fill_logged) {
      await appendTradeJournalEvent(
        'buy_order_filled',
        buildExitJournalPayload({
          plan,
          config,
          sourceBuyOrderIDEx: orderIDEx,
          lifecycleStatus: 'buy_filled',
          brokerOrder: normalizeForJson(order || null),
          fills: normalizeForJson(fills || null),
          position: normalizeForJson(position || null),
          filledQty,
          fillAvgPrice,
          remainingQty,
          canSellQty,
          state: nextState,
        }),
      );
      nextState.buy_fill_logged = true;
    }

    if (remainingQty <= 0) {
      nextState = { ...nextState, status: 'closed', updated_at: new Date().toISOString() };
      if (!stateRow.closed_logged) {
        await appendTradeJournalEvent(
          'position_closed',
          buildExitJournalPayload({
            plan,
            config,
            sourceBuyOrderIDEx: orderIDEx,
            lifecycleStatus: 'closed',
            brokerOrder: normalizeForJson(order || null),
            fills: normalizeForJson(fills || null),
            position: normalizeForJson(position || null),
            filledQty,
            fillAvgPrice,
            remainingQty,
            canSellQty,
            state: nextState,
          }),
        );
        nextState.closed_logged = true;
      }
      state.orders[orderIDEx] = nextState;
      continue;
    }
    if (exitQty <= 0) {
      nextState = {
        ...nextState,
        status: 'waiting_sellable_qty',
        updated_at: new Date().toISOString(),
      };
      const changed = stateRow.status !== nextState.status || stateRow.can_sell_qty !== nextState.can_sell_qty;
      state.orders[orderIDEx] = nextState;
      if (changed) {
        await appendTradeJournalEvent(
          'position_waiting_sellable_qty',
          buildExitJournalPayload({
            plan,
            config,
            sourceBuyOrderIDEx: orderIDEx,
            lifecycleStatus: 'waiting_sellable_qty',
            brokerOrder: normalizeForJson(order || null),
            fills: normalizeForJson(fills || null),
            position: normalizeForJson(position || null),
            filledQty,
            fillAvgPrice,
            remainingQty,
            canSellQty,
            state: nextState,
          }),
        );
      }
      continue;
    }

    watched += 1;
    const optionSecurity = plan.contract?.security;
    const underlyingSecurity = {
      market: QOT_MARKET_US_SECURITY,
      code: plan.contract?.owner?.code || moomooUnderlyingCode(plan.signal?.ticker),
    };
    const quoteResult = await quoteFeed.getSnapshots([optionSecurity], {
      orderBookSecurities: [optionSecurity],
    });
    let underlyingQuoteResult = null;
    let underlyingQuoteError = null;
    if (underlyingSecurity.code && underlyingSecurity.code !== '.SPX') {
      try {
        underlyingQuoteResult = await quoteFeed.getSnapshots([underlyingSecurity], {
          orderBookSecurities: [],
        });
      } catch (error) {
        underlyingQuoteError = error.message;
      }
    }
    const snapshots = quoteResult.snapshots || [];
    const optionSnapshot = snapshots.find((item) => item?.basic?.security?.code === optionSecurity.code) || null;
    const underlyingSnapshots = underlyingQuoteResult?.snapshots || [];
    const underlyingSnapshot = underlyingSnapshots.find((item) => item?.basic?.security?.code === underlyingSecurity.code) || null;
    const quoteModel = buildOptionExecutionQuote(optionSnapshot, config);
    const underlyingPrice = numeric(underlyingSnapshot?.basic?.curPrice);
    const now = new Date();
    const skipCloseExit = isSameDayControlledOvernightHold(stateRow, now);
    const trigger = carryoverCloseExitTrigger(stateRow, now) || exitTrigger(plan, underlyingPrice, {
      config,
      now,
      skipCloseExit,
      optionQuote: quoteModel,
      entryOptionPrice: fillAvgPrice,
    });
    const optionExitPrice = sellLimitPriceFromQuote(quoteModel, trigger);
    const overnightDecision = controlledOvernightHoldDecision({
      plan,
      stateRow,
      trigger,
      optionQuote: quoteModel,
      entryOptionPrice: fillAvgPrice,
      config,
      overnightHeldCount: controlledOvernightHeld,
      now,
    });

    nextState = {
      ...nextState,
      status: overnightDecision ? 'controlled_overnight_hold' : (trigger ? 'exit_triggered' : (skipCloseExit ? 'controlled_overnight_hold' : 'monitoring')),
      underlying_price: underlyingPrice,
      underlying_quote_error: underlyingQuoteError,
      option_entry_price: fillAvgPrice,
      option_exit_price: optionExitPrice,
      option_return_pct: optionReturnPct(fillAvgPrice, optionExitPrice),
      last_trigger: overnightDecision || trigger,
      updated_at: new Date().toISOString(),
    };
    if (overnightDecision) {
      nextState = {
        ...nextState,
        controlled_overnight: overnightDecision,
        controlled_overnight_started_at: new Date().toISOString(),
        controlled_overnight_trade_date: overnightDecision.controlled_overnight_trade_date,
      };
    }
    state.orders[orderIDEx] = nextState;
    await appendTradeJournalEvent(
      'position_monitor_snapshot',
      buildExitJournalPayload({
        plan,
        config,
        sourceBuyOrderIDEx: orderIDEx,
        lifecycleStatus: nextState.status,
        brokerOrder: normalizeForJson(order || null),
        fills: normalizeForJson(fills || null),
        position: normalizeForJson(position || null),
        filledQty,
        fillAvgPrice,
        remainingQty,
        canSellQty,
        optionQuote: quoteModel,
        optionSnapshotBasic: normalizeForJson(optionSnapshot?.basic || null),
        underlyingSnapshotBasic: normalizeForJson(underlyingSnapshot?.basic || null),
        underlyingPrice,
        quoteFeed: normalizeForJson(quoteResult.feed_status || null),
        quoteSubscription: normalizeForJson(quoteResult.subscription || null),
        trigger: overnightDecision || trigger,
        state: nextState,
      }),
    );
    if (overnightDecision) {
      controlledOvernightHeld += 1;
      await appendTradeJournalEvent(
        'controlled_overnight_hold',
        buildExitJournalPayload({
          plan,
          config,
          sourceBuyOrderIDEx: orderIDEx,
          lifecycleStatus: 'controlled_overnight_hold',
          brokerOrder: normalizeForJson(order || null),
          fills: normalizeForJson(fills || null),
          position: normalizeForJson(position || null),
          filledQty,
          fillAvgPrice,
          remainingQty,
          canSellQty,
          optionQuote: quoteModel,
          optionSnapshotBasic: normalizeForJson(optionSnapshot?.basic || null),
          underlyingSnapshotBasic: normalizeForJson(underlyingSnapshot?.basic || null),
          underlyingPrice,
          quoteFeed: normalizeForJson(quoteResult.feed_status || null),
          quoteSubscription: normalizeForJson(quoteResult.subscription || null),
          trigger: overnightDecision,
          state: nextState,
          extra: {
            skipped_close_exit_trigger: normalizeForJson(trigger || null),
          },
        }),
      );
      continue;
    }
    if (!trigger) continue;

    await appendTradeJournalEvent(
      'exit_triggered',
      buildExitJournalPayload({
        plan,
        config,
        sourceBuyOrderIDEx: orderIDEx,
        lifecycleStatus: 'exit_triggered',
        brokerOrder: normalizeForJson(order || null),
        fills: normalizeForJson(fills || null),
        position: normalizeForJson(position || null),
        filledQty,
        fillAvgPrice,
        remainingQty,
        canSellQty,
        optionQuote: quoteModel,
        optionSnapshotBasic: normalizeForJson(optionSnapshot?.basic || null),
        underlyingSnapshotBasic: normalizeForJson(underlyingSnapshot?.basic || null),
        underlyingPrice,
        quoteFeed: normalizeForJson(quoteResult.feed_status || null),
        quoteSubscription: normalizeForJson(quoteResult.subscription || null),
        trigger,
        state: nextState,
      }),
    );

    const sellPrice = sellLimitPriceFromQuote(quoteModel, trigger);
    if (sellPrice === null) {
      nextState = {
        ...nextState,
        status: 'exit_blocked_missing_bid',
        option_quote: quoteModel,
      };
      state.orders[orderIDEx] = nextState;
      await appendTradeJournalEvent(
        'exit_blocked_missing_bid',
        buildExitJournalPayload({
          plan,
          config,
          sourceBuyOrderIDEx: orderIDEx,
          lifecycleStatus: 'exit_blocked_missing_bid',
          brokerOrder: normalizeForJson(order || null),
          fills: normalizeForJson(fills || null),
          position: normalizeForJson(position || null),
          filledQty,
          fillAvgPrice,
          remainingQty,
          canSellQty,
          optionQuote: quoteModel,
          optionSnapshotBasic: normalizeForJson(optionSnapshot?.basic || null),
          underlyingSnapshotBasic: normalizeForJson(underlyingSnapshot?.basic || null),
          underlyingPrice,
          quoteFeed: normalizeForJson(quoteResult.feed_status || null),
          quoteSubscription: normalizeForJson(quoteResult.subscription || null),
          trigger,
          state: nextState,
        }),
      );
      continue;
    }

    const remark = `exit:${String(plan.signal?.message_id || '').slice(-12)}`;
    let response;
    try {
      response = await placeLimitSellOrder(client, config, {
        code,
        qty: exitQty,
        price: sellPrice,
        remark,
        positionID: position?.positionID,
      });
    } catch (error) {
      nextState = {
        ...nextState,
        status: 'exit_submit_failed',
        exit_price: sellPrice,
        exit_qty: exitQty,
        exit_trigger: trigger,
        exit_error: error.message,
        updated_at: new Date().toISOString(),
      };
      state.orders[orderIDEx] = nextState;
      await appendTradeJournalEvent(
        'exit_order_submit_failed',
        buildExitJournalPayload({
          plan,
          config,
          sourceBuyOrderIDEx: orderIDEx,
          lifecycleStatus: 'exit_submit_failed',
          brokerOrder: normalizeForJson(order || null),
          fills: normalizeForJson(fills || null),
          position: normalizeForJson(position || null),
          filledQty,
          fillAvgPrice,
          remainingQty,
          canSellQty,
          optionQuote: quoteModel,
          optionSnapshotBasic: normalizeForJson(optionSnapshot?.basic || null),
          underlyingSnapshotBasic: normalizeForJson(underlyingSnapshot?.basic || null),
          underlyingPrice,
          quoteFeed: normalizeForJson(quoteResult.feed_status || null),
          quoteSubscription: normalizeForJson(quoteResult.subscription || null),
          trigger,
          exitOrder: {
            side: 'SELL_TO_CLOSE',
            code,
            qty: exitQty,
            price: sellPrice,
            price_basis: quoteModel.sell_estimate_basis,
            remark,
          },
          state: nextState,
          extra: {
            submit_error: error.message,
          },
        }),
      );
      continue;
    }
    submittedExits += 1;
    const exitPayload = {
      submitted_at: new Date().toISOString(),
      source_buy_order_id_ex: orderIDEx,
      signal: plan.signal,
      code,
      qty: exitQty,
      price: sellPrice,
      price_basis: quoteModel.sell_estimate_basis,
      trigger,
      underlying_quote: normalizeForJson(underlyingSnapshot?.basic || null),
      option_quote: quoteModel,
      option_quote_source: optionSnapshot?.quote_source || 'snapshot',
      option_quote_received_at: optionSnapshot?.quote_received_at || null,
      underlying_quote_source: underlyingSnapshot?.quote_source || 'snapshot',
      underlying_quote_received_at: underlyingSnapshot?.quote_received_at || null,
      quote_feed: normalizeForJson(quoteResult.feed_status || null),
      quote_subscription: normalizeForJson(quoteResult.subscription || null),
      response: normalizeForJson(response),
    };
    await appendJsonLine(exitOrdersPath, exitPayload);
    nextState = {
      ...nextState,
      status: 'exit_submitted',
      exit_order_id_ex: String(response.s2c?.orderIDEx || ''),
      exit_submitted_at: exitPayload.submitted_at,
      exit_price: sellPrice,
      exit_qty: exitQty,
      exit_trigger: trigger,
      updated_at: new Date().toISOString(),
    };
    state.orders[orderIDEx] = nextState;
    await appendTradeJournalEvent(
      'exit_order_submitted',
      buildExitJournalPayload({
        plan,
        config,
        sourceBuyOrderIDEx: orderIDEx,
        lifecycleStatus: 'exit_submitted',
        brokerOrder: normalizeForJson(order || null),
        fills: normalizeForJson(fills || null),
        position: normalizeForJson(position || null),
        filledQty,
        fillAvgPrice,
        remainingQty,
        canSellQty,
        optionQuote: quoteModel,
        optionSnapshotBasic: normalizeForJson(optionSnapshot?.basic || null),
        underlyingSnapshotBasic: normalizeForJson(underlyingSnapshot?.basic || null),
        underlyingPrice,
        quoteFeed: normalizeForJson(quoteResult.feed_status || null),
        quoteSubscription: normalizeForJson(quoteResult.subscription || null),
        trigger,
        exitOrder: {
          side: 'SELL_TO_CLOSE',
          code,
          qty: exitQty,
          price: sellPrice,
          price_basis: quoteModel.sell_estimate_basis,
          remark,
        },
        exitResponse: normalizeForJson(response),
        state: nextState,
      }),
    );
  }

  await writeState(state);
  await writeStatus({
    phase: 'ok',
    mode,
    plans: plans.length,
    watched,
    submitted_exits: submittedExits,
    quote_feed: quoteFeed.status(),
  });
  return { plans: plans.length, watched, submittedExits };
}

async function main() {
  const config = loadMoomooConfig({ envFile: args.env });
  const mode = getMode(config);
  const pollSeconds = Math.max(5, Number(args['poll-seconds'] || process.env.MOOMOO_EXIT_POLL_SECONDS || 5));
  const conn = await connectMoomoo(config);
  const quoteFeed = createMoomooQuoteFeed(conn.client, config);
  try {
    const tradingAccount = await ensureTradingAccount(conn.client, config, mode);
    await writeStatus({
      phase: 'started',
      mode,
      trading_account: tradingAccount.account,
      poll_seconds: pollSeconds,
      quote_feed: quoteFeed.status(),
    });
    for (;;) {
      const state = loadState();
      let result;
      try {
        result = await processOnce(conn.client, config, state, quoteFeed, mode);
      } catch (error) {
        const transient = transientPollError(error);
        if (!args.watch || !transient) throw error;
        await writeStatus({
          phase: transient.kind,
          mode,
          error: transient.message,
          cooldown_seconds: transient.cooldownSeconds,
          poll_seconds: pollSeconds,
          quote_feed: quoteFeed.status(),
        });
        console.error(`[${new Date().toISOString()}] OpenD poll ${transient.kind}; cooling down ${transient.cooldownSeconds}s`);
        await new Promise((resolve) => setTimeout(resolve, transient.cooldownSeconds * 1000));
        continue;
      }
      console.log(`[${new Date().toISOString()}] mode=${mode} plans=${result.plans} watched=${result.watched} submitted_exits=${result.submittedExits} pushes=${quoteFeed.status().push_count}`);
      if (!args.watch) break;
      await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
    }
  } finally {
    await quoteFeed.close();
    conn.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeStatus({ phase: 'error', error: error.message });
    console.error(error);
    process.exit(1);
  });
}
