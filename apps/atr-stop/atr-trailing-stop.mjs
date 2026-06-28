import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_ROOT,
  QOT_MARKET_US_SECURITY,
  TRD_ENV_REAL,
  cancelOrder,
  connectMoomoo,
  ensureDir,
  fetchMoomooAccounts,
  fetchOrderFillList,
  fetchOrderList,
  fetchPositionList,
  isProtectedStockSymbol,
  loadMoomooConfig,
  maskId,
  normalizeForJson,
  parseCliArgs,
  placeMarketSellOrder,
  placeStopMarketSellOrder,
  requestHistoryKL,
  selectConfiguredUsRealAccount,
} from '../../packages/moomoo-opend/moomoo-opend.mjs';

const args = parseCliArgs();
const logsDir = path.join(PROJECT_ROOT, 'logs');
const statusPath = path.join(logsDir, 'atr-stop-status.json');
const statePath = path.join(logsDir, 'atr-stop-state.json');
const ordersPath = path.join(logsDir, 'atr-stop-orders.ndjson');
const defaultAtrPeriod = 21;
const defaultAtrMultiplier = 2.5;
const defaultLimitBufferPct = 0.35;
const defaultFallbackSeconds = 45;
const defaultMaxInitialLossPct = 0.12;
const defaultBreakevenTriggerProfitPct = 0.08;
const defaultBreakevenFloorProfitPct = 0.005;
const defaultProfitProtectionTriggerPct = 0.15;
const defaultProfitProtectionMaxDrawdownPct = 0.15;

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function roundPct(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(4)) : null;
}

function roundPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(4)) : null;
}

function pctFraction(value, defaultValue) {
  const parsed = numeric(value);
  if (parsed === null) return defaultValue;
  return parsed > 1 ? parsed / 100 : parsed;
}

function decimalPlaces(value) {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot >= 0 ? Math.min(6, text.length - dot - 1) : 0;
}

function roundDownToTick(value, tick = 0.01) {
  const normalizedTick = Number.isFinite(tick) && tick > 0 ? tick : 0.01;
  const decimals = Math.max(2, decimalPlaces(normalizedTick));
  return Number((Math.floor((value / normalizedTick) + 1e-9) * normalizedTick).toFixed(decimals));
}

export function marketableStopLimitPrice(realtimePrice, opts = {}) {
  const price = numeric(realtimePrice);
  if (price === null || price <= 0) return null;
  const bufferPct = numeric(opts.bufferPct) ?? defaultLimitBufferPct;
  const tick = numeric(opts.tick) ?? 0.01;
  return Math.max(tick, roundDownToTick(price * (1 - Math.max(0, bufferPct) / 100), tick));
}

function isTruthyFlag(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function booleanSetting(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return isTruthyFlag(value);
}

function validatePctFraction(value, name) {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`${name} must be a fraction between 0 and 1, or a percent value between 0 and 100.`);
  }
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function isStockSymbol(value) {
  const symbol = normalizeSymbol(value);
  if (!symbol) return false;
  if (/\d{6}[CP]\d{8}/.test(symbol)) return false;
  return /^[A-Z][A-Z0-9.-]{0,12}$/.test(symbol);
}

function stockSecurity(symbol) {
  return { market: QOT_MARKET_US_SECURITY, code: normalizeSymbol(symbol) };
}

function normalizeStockPositions(positionList) {
  const out = [];
  for (const raw of positionList || []) {
    const symbol = normalizeSymbol(raw?.code);
    const qty = Math.floor(numeric(raw?.qty) ?? 0);
    if (!isStockSymbol(symbol) || qty <= 0) continue;
    out.push({
      symbol,
      qty,
      can_sell_qty: Math.floor(numeric(raw.canSellQty) ?? qty),
      price: numeric(raw.price),
      entry_price: numeric(raw.averageCostPrice) ?? numeric(raw.dilutedCostPrice) ?? numeric(raw.costPrice) ?? numeric(raw.price),
      position_id: raw.positionID,
      raw: normalizeForJson(raw),
    });
  }
  return out;
}

function normalizeBars(klList) {
  return (klList || [])
    .filter((bar) => !bar.isBlank)
    .map((bar) => ({
      date: String(bar.time || '').slice(0, 10),
      high: numeric(bar.highPrice),
      low: numeric(bar.lowPrice),
      close: numeric(bar.closePrice),
      raw: normalizeForJson(bar),
    }))
    .filter((bar) => bar.date && bar.high !== null && bar.low !== null && bar.close !== null)
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function calculateAtrWilder(bars, period = defaultAtrPeriod) {
  if (!Array.isArray(bars) || bars.length < period + 1) {
    throw new Error('INSUFFICIENT_ATR_DATA');
  }
  const trs = [];
  for (let index = 1; index < bars.length; index += 1) {
    const high = Number(bars[index].high);
    const low = Number(bars[index].low);
    const previousClose = Number(bars[index - 1].close);
    if (![high, low, previousClose].every(Number.isFinite)) {
      throw new Error('INVALID_ATR_BAR');
    }
    trs.push(Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose),
    ));
  }
  if (trs.length < period) throw new Error('INSUFFICIENT_ATR_DATA');
  let atr = trs.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
  for (const tr of trs.slice(period)) {
    atr = (atr * (period - 1) + tr) / period;
  }
  return Number(atr.toFixed(6));
}

export function updateDailyAtrStop(position, bars, opts = {}) {
  const period = opts.period ?? defaultAtrPeriod;
  const multiplier = opts.multiplier ?? defaultAtrMultiplier;
  const maxInitialLossPct = pctFraction(opts.maxInitialLossPct, defaultMaxInitialLossPct);
  const breakevenEnabled = opts.breakevenEnabled !== false;
  const breakevenTriggerProfitPct = pctFraction(opts.breakevenTriggerProfitPct, defaultBreakevenTriggerProfitPct);
  const breakevenFloorProfitPct = pctFraction(opts.breakevenFloorProfitPct, defaultBreakevenFloorProfitPct);
  const profitProtectionEnabled = opts.profitProtectionEnabled !== false;
  const profitProtectionTriggerPct = pctFraction(opts.profitProtectionTriggerPct, defaultProfitProtectionTriggerPct);
  const profitProtectionMaxDrawdownPct = pctFraction(opts.profitProtectionMaxDrawdownPct, defaultProfitProtectionMaxDrawdownPct);
  const atr = calculateAtrWilder(bars, period);
  const latest = bars[bars.length - 1];
  const entryPrice = numeric(position.entry_price) ?? numeric(latest.close);
  const closeSinceEntry = String(position.entry_date || '')
    ? bars.filter((bar) => bar.date >= String(position.entry_date)).map((bar) => numeric(bar.close)).filter((value) => value !== null)
    : [];
  const historicalHighestClose = closeSinceEntry.length > 0 ? Math.max(...closeSinceEntry) : null;
  const highestClose = Math.max(
    numeric(position.highest_close_since_entry) ?? historicalHighestClose ?? entryPrice ?? latest.close,
    latest.close,
  );
  const previousStop = numeric(position.current_stop_price);
  const atrStop = highestClose - multiplier * atr;
  const initialLossFloor = entryPrice === null ? null : entryPrice * (1 - maxInitialLossPct);
  const breakevenFloor = breakevenEnabled
    && entryPrice !== null
    && highestClose >= entryPrice * (1 + breakevenTriggerProfitPct)
    ? entryPrice * (1 + breakevenFloorProfitPct)
    : null;
  const profitTrailingFloor = profitProtectionEnabled
    && entryPrice !== null
    && highestClose >= entryPrice * (1 + profitProtectionTriggerPct)
    ? highestClose * (1 - profitProtectionMaxDrawdownPct)
    : null;
  const stopComponents = {
    previous_stop: roundPrice(previousStop),
    atr_stop: roundPrice(atrStop),
    initial_loss_floor: roundPrice(initialLossFloor),
    breakeven_floor: roundPrice(breakevenFloor),
    profit_trailing_floor: roundPrice(profitTrailingFloor),
  };
  const candidateStops = Object.entries(stopComponents)
    .filter(([, value]) => numeric(value) !== null)
    .map(([source, value]) => ({ source, value: Number(value) }));
  const currentStop = Math.max(...candidateStops.map((item) => item.value));
  const currentStopRounded = roundPrice(currentStop);
  const stopSource = candidateStops
    .filter((item) => Math.abs(item.value - currentStopRounded) < 0.0001)
    .map((item) => item.source)
    .join(',');
  const stopMovedUp = previousStop === null || currentStopRounded > previousStop + 0.0001;
  const closeTriggeredAfterClose = numeric(latest.close) !== null && currentStopRounded !== null && latest.close <= currentStopRounded;
  const nextStatus = position.status === 'PENDING_SELL' || position.status === 'SOLD'
    ? position.status
    : (closeTriggeredAfterClose ? 'STOP_TRIGGERED_AFTER_CLOSE' : 'HELD');
  return {
    ...position,
    highest_close_since_entry: Number(highestClose.toFixed(4)),
    current_atr: atr,
    atr_points: atr,
    current_stop_price: currentStopRounded,
    previous_stop_price: roundPrice(previousStop),
    atr_stop_price: stopComponents.atr_stop,
    initial_loss_floor: stopComponents.initial_loss_floor,
    breakeven_floor: stopComponents.breakeven_floor,
    profit_trailing_floor: stopComponents.profit_trailing_floor,
    stop_components: stopComponents,
    stop_source: stopSource,
    stop_moved_up: stopMovedUp,
    close_triggered_after_close: closeTriggeredAfterClose,
    next_open_sell_required: closeTriggeredAfterClose,
    confirmed_bar_date: latest.date,
    confirmed_close_price: Number(latest.close.toFixed(4)),
    stop_basis: 'max_previous_atr_initial_breakeven_profit_floors',
    atr_period: period,
    atr_multiplier: multiplier,
    atr_method: 'wilder',
    price_basis: 'adjusted_ohlc',
    max_initial_loss_pct: maxInitialLossPct,
    breakeven_enabled: breakevenEnabled,
    breakeven_trigger_profit_pct: breakevenTriggerProfitPct,
    breakeven_floor_profit_pct: breakevenFloorProfitPct,
    profit_protection_enabled: profitProtectionEnabled,
    profit_protection_trigger_pct: profitProtectionTriggerPct,
    profit_protection_max_drawdown_pct: profitProtectionMaxDrawdownPct,
    last_update_date: latest.date,
    status: nextStatus,
    error: null,
  };
}

function loadState() {
  if (!fs.existsSync(statePath)) return { positions: {} };
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { positions: {} };
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

async function appendOrder(payload) {
  await ensureDir(path.dirname(ordersPath));
  await fsp.appendFile(ordersPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function newYorkDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const out = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: out.weekday,
    date: `${out.year}-${out.month}-${out.day}`,
    hour: Number(out.hour === '24' ? '0' : out.hour),
    minute: Number(out.minute),
  };
}

export function confirmedDailyBars(bars, now = new Date()) {
  const ny = newYorkDateParts(now);
  const minutes = ny.hour * 60 + ny.minute;
  const todayConfirmed = minutes >= 16 * 60 + 5;
  return (bars || []).filter((bar) => bar.date < ny.date || (bar.date === ny.date && todayConfirmed));
}

function isWeekday(parts) {
  return !['Sat', 'Sun'].includes(parts.weekday);
}

export function isRegularSessionNow(date = new Date()) {
  const parts = newYorkDateParts(date);
  const minutes = parts.hour * 60 + parts.minute;
  return isWeekday(parts) && minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
}

function daysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return dateKey(date);
}

async function fetchDailyBars(client, symbol, lookbackDays) {
  const response = await requestHistoryKL(client, stockSecurity(symbol), {
    beginTime: daysAgo(lookbackDays),
    endTime: dateKey(new Date()),
    maxAckKLNum: Math.max(60, lookbackDays),
  });
  return normalizeBars(normalizeForJson(response).s2c?.klList || []);
}

function initializePosition(row, previous, bars) {
  const latest = bars[bars.length - 1] || null;
  const entryPrice = numeric(previous?.entry_price) ?? numeric(row.entry_price) ?? numeric(row.price);
  const entryDate = previous?.entry_date || latest?.date || dateKey(new Date());
  const carryStatuses = new Set(['PENDING_SELL', 'SOLD', 'STOP_TRIGGERED_AFTER_CLOSE', 'NEXT_OPEN_SELL_PENDING']);
  const status = carryStatuses.has(previous?.status) ? previous.status : 'HELD';
  return {
    symbol: row.symbol,
    entry_date: entryDate,
    entry_price: entryPrice,
    shares: Math.floor(row.qty),
    can_sell_qty: Math.floor(row.can_sell_qty),
    position_id: row.position_id,
    highest_close_since_entry: numeric(previous?.highest_close_since_entry) ?? Math.max(entryPrice ?? 0, latest?.close ?? 0),
    current_atr: numeric(previous?.current_atr),
    atr_points: numeric(previous?.atr_points) ?? numeric(previous?.current_atr),
    current_stop_price: numeric(previous?.current_stop_price),
    previous_stop_price: numeric(previous?.previous_stop_price),
    atr_stop_price: numeric(previous?.atr_stop_price),
    initial_loss_floor: numeric(previous?.initial_loss_floor),
    breakeven_floor: numeric(previous?.breakeven_floor),
    profit_trailing_floor: numeric(previous?.profit_trailing_floor),
    stop_components: previous?.stop_components || null,
    stop_source: previous?.stop_source || '',
    stop_moved_up: Boolean(previous?.stop_moved_up),
    close_triggered_after_close: Boolean(previous?.close_triggered_after_close),
    next_open_sell_required: Boolean(previous?.next_open_sell_required),
    confirmed_bar_date: previous?.confirmed_bar_date || '',
    confirmed_close_price: numeric(previous?.confirmed_close_price),
    stop_basis: previous?.stop_basis || '',
    atr_period: numeric(previous?.atr_period),
    atr_multiplier: numeric(previous?.atr_multiplier),
    atr_method: previous?.atr_method || '',
    price_basis: previous?.price_basis || '',
    max_initial_loss_pct: numeric(previous?.max_initial_loss_pct),
    breakeven_enabled: previous?.breakeven_enabled ?? null,
    breakeven_trigger_profit_pct: numeric(previous?.breakeven_trigger_profit_pct),
    breakeven_floor_profit_pct: numeric(previous?.breakeven_floor_profit_pct),
    profit_protection_enabled: previous?.profit_protection_enabled ?? null,
    profit_protection_trigger_pct: numeric(previous?.profit_protection_trigger_pct),
    profit_protection_max_drawdown_pct: numeric(previous?.profit_protection_max_drawdown_pct),
    stop_order_id_ex: previous?.stop_order_id_ex || '',
    stop_order_stop_price: numeric(previous?.stop_order_stop_price),
    stop_order_status: previous?.stop_order_status || '',
    stop_order_submitted_at: previous?.stop_order_submitted_at || '',
    stop_order_replaced_at: previous?.stop_order_replaced_at || '',
    next_open_sell_queued_at: previous?.next_open_sell_queued_at || '',
    next_open_sell_order_id_ex: previous?.next_open_sell_order_id_ex || '',
    last_update_date: previous?.last_update_date || '',
    status,
    error: previous?.error || null,
    updated_at: new Date().toISOString(),
  };
}

async function refreshAtrState(client, config, state, settings) {
  const response = await fetchPositionList(client, config);
  const positions = normalizeStockPositions(normalizeForJson(response).s2c?.positionList || []);
  const protectedSymbols = settings.protectedSymbols || [];
  const currentSymbols = new Set(positions.map((position) => position.symbol));

  for (const [symbol, previous] of Object.entries(state.positions || {})) {
    if (!currentSymbols.has(symbol) && previous.status !== 'SOLD') {
      const soldByManagedOrder = previous.status === 'PENDING_SELL' || previous.stop_order_id_ex || previous.next_open_sell_order_id_ex;
      state.positions[symbol] = {
        ...previous,
        status: soldByManagedOrder ? 'SOLD' : previous.status,
        shares: 0,
        can_sell_qty: 0,
        sold_reason: soldByManagedOrder ? 'POSITION_NOT_FOUND_AFTER_MANAGED_SELL' : previous.sold_reason,
        sold_time: soldByManagedOrder ? new Date().toISOString() : previous.sold_time,
        updated_at: new Date().toISOString(),
      };
    }
  }

  for (const row of positions) {
    const previous = state.positions[row.symbol] || null;
    if (isProtectedStockSymbol(row.symbol, protectedSymbols)) {
      const protectedPosition = attachRiskMetrics({
        ...initializePosition(row, previous, []),
        status: 'PROTECTED',
        current_atr: null,
        atr_points: null,
        current_stop_price: null,
        error: null,
        protection_reason: 'protected_stock_symbol',
        shares: Math.floor(row.qty),
        can_sell_qty: Math.floor(row.can_sell_qty),
        position_id: row.position_id,
        updated_at: new Date().toISOString(),
      }, row.price);
      state.positions[row.symbol] = protectedPosition;
      continue;
    }
    let bars = [];
    let next = null;
    try {
      bars = confirmedDailyBars(await fetchDailyBars(client, row.symbol, settings.lookbackDays));
      next = updateDailyAtrStop(initializePosition(row, previous, bars), bars, settings);
    } catch (error) {
      const initialized = initializePosition(row, previous, bars);
      next = {
        ...initialized,
        status: initialized.status === 'PENDING_SELL' || initialized.status === 'SOLD' ? initialized.status : 'DISABLED',
        error: error.message === 'INSUFFICIENT_ATR_DATA' ? 'INSUFFICIENT_ATR_DATA' : error.message,
      };
    }
    next.shares = Math.floor(row.qty);
    next.can_sell_qty = Math.floor(row.can_sell_qty);
    next.position_id = row.position_id;
    next.updated_at = new Date().toISOString();
    state.positions[row.symbol] = attachRiskMetrics(next, row.price);
  }
  return positions;
}

function attachRiskMetrics(position, realtimePrice, snapshot = null) {
  const price = numeric(realtimePrice);
  const entry = numeric(position.entry_price);
  const shares = Math.floor(numeric(position.shares) ?? 0);
  const stop = numeric(position.current_stop_price);
  const next = {
    ...position,
    current_price: price,
    price_updated_at: price === null ? position.price_updated_at || null : new Date().toISOString(),
    quote: snapshot?.basic ? normalizeForJson(snapshot.basic) : position.quote || null,
  };
  if (price !== null && shares > 0) {
    next.market_value = roundMoney(price * shares);
  }
  if (price !== null && entry !== null && shares > 0) {
    const pnl = (price - entry) * shares;
    next.unrealized_pnl = roundMoney(pnl);
    next.unrealized_pnl_pct = entry > 0 ? roundPct((price - entry) / entry * 100) : null;
  }
  if (price !== null && stop !== null) {
    next.distance_to_stop = roundPrice(price - stop);
    next.distance_to_stop_pct = price > 0 ? roundPct((price - stop) / price * 100) : null;
  }
  if (numeric(next.current_atr) !== null) {
    next.atr_points = numeric(next.current_atr);
  }
  return next;
}

function byOrderIDEx(orderList) {
  const out = new Map();
  for (const row of orderList || []) {
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
    const current = out.get(id) || { sellQty: 0, sellValue: 0, fills: [] };
    const qty = numeric(fill.qty) ?? 0;
    const price = numeric(fill.price) ?? 0;
    if (Number(fill.trdSide) === 2) {
      current.sellQty += qty;
      current.sellValue += qty * price;
    }
    current.fills.push(normalizeForJson(fill));
    out.set(id, current);
  }
  return out;
}

function pendingOrderIds(position) {
  return [
    position.sell_order_id_ex,
    position.fallback_order_id_ex,
    ...(Array.isArray(position.sell_order_id_exes) ? position.sell_order_id_exes : []),
  ].map((id) => String(id || '')).filter(Boolean);
}

function isFilledOrderStatus(status) {
  return Number(status) === 11;
}

function isTerminalUnfilledOrderStatus(status) {
  return [3, 15, 21, 22, 23, 24].includes(Number(status));
}

async function safeOrderFillList(client, config) {
  try {
    return normalizeForJson((await fetchOrderFillList(client, config)).s2c?.orderFillList || []);
  } catch (error) {
    return [{ error: error.message }];
  }
}

async function submitFallbackMarketSell(client, config, position, qty, reason) {
  const payload = {
    submitted_at: new Date().toISOString(),
    business_line: 'atr_trailing_stop',
    side: 'SELL',
    symbol: position.symbol,
    qty,
    order_type: 'MARKET',
    reason,
    source_order_id_ex: position.sell_order_id_ex || '',
  };
  try {
    const response = await placeMarketSellOrder(client, config, {
      code: position.symbol,
      qty,
      remark: 'ATR_STOP_FALLBACK_MARKET',
      positionID: position.position_id,
    });
    payload.status = 'submitted';
    payload.response = normalizeForJson(response);
    await appendOrder(payload);
    return {
      orderIDEx: String(response.s2c?.orderIDEx || ''),
      payload,
    };
  } catch (error) {
    payload.status = 'submit_failed';
    payload.error = error.message;
    await appendOrder(payload);
    throw error;
  }
}

async function refreshPendingSells(client, config, state, livePositions, settings, execute) {
  const pending = Object.values(state.positions || {})
    .filter((position) => position.status === 'PENDING_SELL');
  if (pending.length === 0) return { pending: 0, sold: 0, fallback_submitted: 0 };

  const orderList = normalizeForJson((await fetchOrderList(client, config)).s2c?.orderList || []);
  const fillList = await safeOrderFillList(client, config);
  const ordersById = byOrderIDEx(orderList);
  const fillsById = fillSummaryByOrderIDEx(fillList.filter((row) => !row.error));
  const liveBySymbol = new Map(livePositions.map((position) => [position.symbol, position]));
  let sold = 0;
  let fallbackSubmitted = 0;

  for (const position of pending) {
    if (isProtectedStockSymbol(position.symbol, settings.protectedSymbols || [])) {
      state.positions[position.symbol] = {
        ...position,
        status: 'PROTECTED',
        error: null,
        protection_reason: 'protected_stock_symbol',
        updated_at: new Date().toISOString(),
      };
      continue;
    }
    const ids = pendingOrderIds(position);
    const orders = ids.map((id) => ordersById.get(id)).filter(Boolean);
    const fillRows = ids.map((id) => fillsById.get(id)).filter(Boolean);
    const filledQty = fillRows.reduce((sum, fill) => sum + fill.sellQty, 0);
    const filledValue = fillRows.reduce((sum, fill) => sum + fill.sellValue, 0);
    const fillAvgPrice = filledQty > 0 ? roundPrice(filledValue / filledQty) : null;
    const live = liveBySymbol.get(position.symbol) || null;
    const expectedQty = Math.floor(numeric(position.sell_qty) ?? numeric(position.last_trigger?.shares) ?? numeric(position.shares) ?? 0);
    const remainingExpected = Math.max(0, expectedQty - Math.floor(filledQty));
    const liveQty = Math.floor(numeric(live?.qty) ?? 0);
    const canSellQty = Math.floor(numeric(live?.can_sell_qty) ?? numeric(position.can_sell_qty) ?? 0);
    const orderStatuses = orders.map((order) => ({
      order_id_ex: String(order.orderIDEx || ''),
      order_status: order.orderStatus ?? null,
      fill_qty: numeric(order.fillQty) ?? 0,
      fill_avg_price: numeric(order.fillAvgPrice) ?? null,
      last_error: order.lastErrMsg || '',
    }));

    let next = attachRiskMetrics({
      ...position,
      shares: live ? live.qty : position.shares,
      can_sell_qty: live ? live.can_sell_qty : position.can_sell_qty,
      position_id: live?.position_id ?? position.position_id,
      pending_order_statuses: orderStatuses,
      pending_filled_qty: roundPrice(filledQty) ?? 0,
      pending_fill_avg_price: fillAvgPrice,
      updated_at: new Date().toISOString(),
    }, live?.price ?? position.current_price);

    const filledAll = expectedQty > 0 && filledQty >= expectedQty;
    const orderFilledAll = orders.some((order) => isFilledOrderStatus(order.orderStatus));
    if (filledAll || orderFilledAll || liveQty <= 0) {
      state.positions[position.symbol] = {
        ...next,
        status: 'SOLD',
        shares: 0,
        can_sell_qty: 0,
        sold_reason: 'ATR_TRAILING_STOP_TRIGGERED',
        sold_time: new Date().toISOString(),
        sold_price: fillAvgPrice ?? numeric(orders.find((order) => numeric(order.fillAvgPrice) !== null)?.fillAvgPrice),
        updated_at: new Date().toISOString(),
      };
      sold += 1;
      continue;
    }

    const submittedAtMs = Date.parse(position.pending_since || position.sell_submitted_at || position.last_trigger?.triggered_at || '');
    const ageSeconds = Number.isFinite(submittedAtMs) ? (Date.now() - submittedAtMs) / 1000 : 0;
    const hasTerminalUnfilled = orders.some((order) => isTerminalUnfilledOrderStatus(order.orderStatus));
    const fallbackDue = ageSeconds >= settings.fallbackSeconds || hasTerminalUnfilled;

    if (
      execute
      && !position.fallback_order_id_ex
      && !position.fallback_market_submitted
      && fallbackDue
      && canSellQty > 0
      && remainingExpected > 0
    ) {
      const fallbackQty = Math.min(canSellQty, remainingExpected);
      try {
        const fallback = await submitFallbackMarketSell(client, config, next, fallbackQty, hasTerminalUnfilled ? 'limit_order_terminal_fallback' : 'limit_order_timeout_fallback');
        next = {
          ...next,
          fallback_market_submitted: true,
          fallback_order_id_ex: fallback.orderIDEx,
          sell_order_id_exes: [...new Set([...ids, fallback.orderIDEx].filter(Boolean))],
          error: null,
          updated_at: new Date().toISOString(),
        };
        fallbackSubmitted += 1;
      } catch (error) {
        next = {
          ...next,
          error: error.message,
          updated_at: new Date().toISOString(),
        };
      }
    }

    state.positions[position.symbol] = next;
  }

  return { pending: pending.length, sold, fallback_submitted: fallbackSubmitted };
}

function activeStopOrderPosition(position, settings) {
  return position
    && !['PENDING_SELL', 'SOLD', 'PROTECTED'].includes(String(position.status || '').toUpperCase())
    && !isProtectedStockSymbol(position.symbol, settings.protectedSymbols || [])
    && numeric(position.current_stop_price) !== null
    && Math.floor(numeric(position.shares) ?? 0) > 0;
}

function sellableQty(position) {
  return Math.min(
    Math.floor(numeric(position.shares) ?? 0),
    Math.floor(numeric(position.can_sell_qty) ?? numeric(position.shares) ?? 0),
  );
}

function closeAlreadyTriggered(position) {
  const close = numeric(position.confirmed_close_price);
  const stop = numeric(position.current_stop_price);
  return Boolean(position.close_triggered_after_close) || (close !== null && stop !== null && close <= stop);
}

async function appendStopOrderEvent(deps, payload) {
  if (typeof deps.appendOrder === 'function') {
    await deps.appendOrder(payload);
  }
}

export async function reconcileBrokerStopOrder(client, config, position, opts = {}) {
  const execute = Boolean(opts.execute);
  const nowIso = opts.nowIso || new Date().toISOString();
  const deps = {
    cancelOrder,
    placeStopMarketSellOrder,
    appendOrder,
    ...(opts.deps || {}),
  };
  const stopPrice = numeric(position.current_stop_price);
  const qty = sellableQty(position);
  const existingOrderIDEx = String(position.stop_order_id_ex || '');
  const existingStop = numeric(position.stop_order_stop_price);
  const basePayload = {
    submitted_at: nowIso,
    business_line: 'atr_trailing_stop',
    side: 'SELL',
    symbol: position.symbol,
    qty,
    order_type: 'STOP_MARKET',
    time_in_force: 'GTC',
    session: 'RTH',
    stop_price: stopPrice,
    existing_stop_order_id_ex: existingOrderIDEx,
    existing_stop_price: existingStop,
  };

  if (stopPrice === null || qty <= 0) {
    return {
      position: {
        ...position,
        stop_order_status: qty <= 0 ? 'NO_SELLABLE_SHARES' : 'NO_STOP_PRICE',
        updated_at: nowIso,
      },
      placed: 0,
      canceled: 0,
      replaced: 0,
      unchanged: 0,
      queued_next_open: 0,
    };
  }

  if (closeAlreadyTriggered(position)) {
    const payload = {
      ...basePayload,
      reason: 'STOP_TRIGGERED_AFTER_CLOSE',
      action: existingOrderIDEx ? 'cancel_existing_stop_and_queue_next_open_sell' : 'queue_next_open_sell',
      confirmed_close_price: numeric(position.confirmed_close_price),
    };
    let canceled = 0;
    let cancelResponse = null;
    if (execute && existingOrderIDEx) {
      cancelResponse = await deps.cancelOrder(client, config, { orderIDEx: existingOrderIDEx });
      canceled = 1;
    }
    payload.status = execute ? 'queued_next_open_sell' : 'queue_required_execute_disabled';
    if (cancelResponse) payload.cancel_response = normalizeForJson(cancelResponse);
    await appendStopOrderEvent(deps, payload);
    return {
      position: {
        ...position,
        status: 'STOP_TRIGGERED_AFTER_CLOSE',
        trigger_reason: 'STOP_TRIGGERED_AFTER_CLOSE',
        next_open_sell_required: true,
        next_open_sell_queued_at: position.next_open_sell_queued_at || nowIso,
        stop_order_id_ex: execute ? '' : existingOrderIDEx,
        stop_order_status: execute ? 'canceled_for_next_open_sell' : 'cancel_required_execute_disabled',
        pending_order_status: execute ? 'queued_next_open_sell' : 'queue_required_execute_disabled',
        updated_at: nowIso,
      },
      placed: 0,
      canceled,
      replaced: 0,
      unchanged: 0,
      queued_next_open: 1,
    };
  }

  if (existingOrderIDEx && existingStop !== null && stopPrice <= existingStop + 0.0001) {
    return {
      position: {
        ...position,
        stop_order_status: 'unchanged',
        updated_at: nowIso,
      },
      placed: 0,
      canceled: 0,
      replaced: 0,
      unchanged: 1,
      queued_next_open: 0,
    };
  }

  const replacing = Boolean(existingOrderIDEx);
  const payload = {
    ...basePayload,
    reason: replacing ? 'STOP_MOVED_UP_CANCEL_REPLACE' : 'INITIAL_GTC_STOP_MARKET',
    action: replacing ? 'cancel_replace' : 'place_stop_market',
  };

  if (!execute) {
    payload.status = replacing ? 'replace_required_execute_disabled' : 'submit_required_execute_disabled';
    await appendStopOrderEvent(deps, payload);
    return {
      position: {
        ...position,
        stop_order_status: payload.status,
        updated_at: nowIso,
      },
      placed: 0,
      canceled: 0,
      replaced: 0,
      unchanged: 0,
      queued_next_open: 0,
    };
  }

  let cancelResponse = null;
  if (replacing) {
    cancelResponse = await deps.cancelOrder(client, config, { orderIDEx: existingOrderIDEx });
  }
  const response = await deps.placeStopMarketSellOrder(client, config, {
    code: position.symbol,
    qty,
    stopPrice,
    remark: 'ATR_GTC_STOP_MARKET',
    positionID: position.position_id,
  });
  const orderIDEx = String(response.s2c?.orderIDEx || '');
  payload.status = replacing ? 'replaced' : 'submitted';
  if (cancelResponse) payload.cancel_response = normalizeForJson(cancelResponse);
  payload.response = normalizeForJson(response);
  await appendStopOrderEvent(deps, payload);

  return {
    position: {
      ...position,
      status: 'HELD',
      stop_order_id_ex: orderIDEx,
      stop_order_stop_price: stopPrice,
      stop_order_type: 'STOP_MARKET',
      stop_order_time_in_force: 'GTC',
      stop_order_session: 'RTH',
      stop_order_status: payload.status,
      stop_order_submitted_at: nowIso,
      stop_order_replaced_at: replacing ? nowIso : position.stop_order_replaced_at || '',
      pending_order_status: '',
      error: null,
      updated_at: nowIso,
    },
    placed: 1,
    canceled: replacing ? 1 : 0,
    replaced: replacing ? 1 : 0,
    unchanged: 0,
    queued_next_open: 0,
  };
}

async function submitNextOpenSells(client, config, state, settings, execute, now = new Date()) {
  const queued = Object.values(state.positions || {})
    .filter((position) => (
      position.next_open_sell_required
      && !['PENDING_SELL', 'SOLD', 'PROTECTED'].includes(String(position.status || '').toUpperCase())
      && !isProtectedStockSymbol(position.symbol, settings.protectedSymbols || [])
      && Math.floor(numeric(position.shares) ?? 0) > 0
    ));
  if (queued.length === 0) return { queued: 0, submitted: 0, waiting_regular_open: 0 };
  if (!isRegularSessionNow(now)) {
    for (const position of queued) {
      state.positions[position.symbol] = {
        ...position,
        pending_order_status: 'waiting_next_regular_open',
        updated_at: new Date().toISOString(),
      };
    }
    return { queued: queued.length, submitted: 0, waiting_regular_open: queued.length };
  }

  let submitted = 0;
  for (const position of queued) {
    const qty = sellableQty(position);
    const submittedAt = new Date().toISOString();
    const payload = {
      submitted_at: submittedAt,
      business_line: 'atr_trailing_stop',
      side: 'SELL',
      symbol: position.symbol,
      qty,
      order_type: 'MARKET',
      reason: 'STOP_TRIGGERED_AFTER_CLOSE_NEXT_OPEN',
    };
    if (qty <= 0) {
      state.positions[position.symbol] = {
        ...position,
        status: 'PENDING_SELL',
        pending_order_status: 'NO_SELLABLE_SHARES',
        updated_at: submittedAt,
      };
      continue;
    }
    if (!execute) {
      state.positions[position.symbol] = {
        ...position,
        status: 'STOP_TRIGGERED_AFTER_CLOSE',
        pending_order_status: 'next_open_market_sell_not_submitted_execute_disabled',
        updated_at: submittedAt,
      };
      continue;
    }
    try {
      const response = await placeMarketSellOrder(client, config, {
        code: position.symbol,
        qty,
        remark: 'ATR_NEXT_OPEN_MARKET',
        positionID: position.position_id,
      });
      payload.status = 'submitted';
      payload.response = normalizeForJson(response);
      submitted += 1;
      state.positions[position.symbol] = {
        ...position,
        status: 'PENDING_SELL',
        sell_order_type: 'MARKET',
        sell_qty: qty,
        sell_order_id_ex: String(response.s2c?.orderIDEx || ''),
        sell_order_id_exes: [String(response.s2c?.orderIDEx || '')].filter(Boolean),
        sell_submitted_at: submittedAt,
        pending_since: submittedAt,
        next_open_sell_required: false,
        next_open_sell_order_id_ex: String(response.s2c?.orderIDEx || ''),
        pending_order_status: 'submitted_next_open_market_sell',
        updated_at: submittedAt,
      };
    } catch (error) {
      payload.status = 'submit_failed';
      payload.error = error.message;
      state.positions[position.symbol] = {
        ...position,
        status: 'STOP_TRIGGERED_AFTER_CLOSE',
        pending_order_status: 'next_open_market_sell_submit_failed',
        error: error.message,
        updated_at: submittedAt,
      };
    }
    await appendOrder(payload);
  }
  return { queued: queued.length, submitted, waiting_regular_open: 0 };
}

async function syncBrokerStopOrders(client, config, state, execute, settings) {
  const held = Object.values(state.positions || {})
    .filter((position) => activeStopOrderPosition(position, settings));
  if (held.length === 0) return { watched: 0, placed: 0, canceled: 0, replaced: 0, unchanged: 0, queued_next_open: 0 };

  let placed = 0;
  let canceled = 0;
  let replaced = 0;
  let unchanged = 0;
  let queuedNextOpen = 0;
  const nowIso = new Date().toISOString();
  for (const position of held) {
    try {
      const result = await reconcileBrokerStopOrder(client, config, position, {
        execute,
        nowIso,
      });
      state.positions[position.symbol] = result.position;
      placed += result.placed;
      canceled += result.canceled;
      replaced += result.replaced;
      unchanged += result.unchanged;
      queuedNextOpen += result.queued_next_open;
    } catch (error) {
      state.positions[position.symbol] = {
        ...position,
        error: error.message,
        stop_order_status: 'sync_failed',
        updated_at: new Date().toISOString(),
      };
    }
  }
  return {
    watched: held.length,
    placed,
    canceled,
    replaced,
    unchanged,
    queued_next_open: queuedNextOpen,
  };
}

function assertRealExecutionAllowed(config, execute) {
  config.trdEnv = TRD_ENV_REAL;
  if (!execute) return;
  if (!config.allowRealTrading) {
    throw new Error('ATR stop real trading is blocked. Set MOOMOO_ALLOW_REAL_TRADING=true in .env first.');
  }
  if (String(process.env.MOOMOO_REAL_TRADING_CONFIRM || '') !== 'I_UNDERSTAND') {
    throw new Error('ATR stop real trading is blocked. Set MOOMOO_REAL_TRADING_CONFIRM=I_UNDERSTAND for the started process.');
  }
}

async function ensureRealAccount(client, config) {
  const accounts = await fetchMoomooAccounts(client);
  const account = selectConfiguredUsRealAccount(accounts, config);
  if (!account) {
    throw new Error('Configured real US trading account was not found. Set MOOMOO_ACC_ID to a real US account.');
  }
  return {
    accID: maskId(account.accID),
    trdEnv: account.trdEnv,
    markets: account.trdMarketAuthList || [],
  };
}

async function runCycle(client, config, settings, execute) {
  const state = loadState();
  const positions = await refreshAtrState(client, config, state, settings);
  const pending = await refreshPendingSells(client, config, state, positions, settings, execute);
  const stopOrders = await syncBrokerStopOrders(client, config, state, execute, settings);
  const nextOpen = await submitNextOpenSells(client, config, state, settings, execute);
  const queuedNextOpen = Math.max(stopOrders.queued_next_open, nextOpen.queued);
  await writeState(state);
  await writeStatus({
    phase: 'ok',
    execute,
    atr_period: settings.period,
    atr_multiplier: settings.multiplier,
    atr_method: settings.atrMethod,
    price_basis: settings.priceBasis,
    max_initial_loss_pct: settings.maxInitialLossPct,
    breakeven: settings.breakeven,
    profit_protection: settings.profitProtection,
    order_management: settings.orderManagement,
    protected_symbols: settings.protectedSymbols,
    positions: positions.length,
    pending_sells: pending.pending,
    sold_this_cycle: pending.sold,
    fallback_submitted: pending.fallback_submitted,
    watched: stopOrders.watched,
    stop_orders_placed: stopOrders.placed,
    stop_orders_canceled: stopOrders.canceled,
    stop_orders_replaced: stopOrders.replaced,
    stop_orders_unchanged: stopOrders.unchanged,
    queued_next_open: queuedNextOpen,
    next_open_submitted: nextOpen.submitted,
    next_open_waiting_regular_open: nextOpen.waiting_regular_open,
    state_path: path.relative(PROJECT_ROOT, statePath),
    orders_path: path.relative(PROJECT_ROOT, ordersPath),
  });
  return {
    watched: stopOrders.watched,
    stop_orders_placed: stopOrders.placed,
    stop_orders_replaced: stopOrders.replaced,
    queued_next_open: queuedNextOpen,
    next_open_submitted: nextOpen.submitted,
  };
}

async function refreshAtrPoints(client, config, settings) {
  const state = loadState();
  const positions = await refreshAtrState(client, config, state, settings);
  await writeState(state);
  const rows = Object.values(state.positions || {});
  await writeStatus({
    phase: 'refreshed',
    execute: false,
    mode: 'atr_refresh_only',
    atr_period: settings.period,
    atr_multiplier: settings.multiplier,
    atr_method: settings.atrMethod,
    price_basis: settings.priceBasis,
    max_initial_loss_pct: settings.maxInitialLossPct,
    breakeven: settings.breakeven,
    profit_protection: settings.profitProtection,
    order_management: settings.orderManagement,
    protected_symbols: settings.protectedSymbols,
    positions: positions.length,
    displayed_positions: rows.length,
    calculated_positions: rows.filter((position) => numeric(position.current_stop_price) !== null).length,
    protected_positions: rows.filter((position) => position.status === 'PROTECTED').length,
    disabled_positions: rows.filter((position) => position.status === 'DISABLED').length,
    state_path: path.relative(PROJECT_ROOT, statePath),
  });
  return {
    positions: positions.length,
    displayed: rows.length,
    calculated: rows.filter((position) => numeric(position.current_stop_price) !== null).length,
  };
}

async function main() {
  const config = loadMoomooConfig({ envFile: args.env });
  const execute = isTruthyFlag(args['execute-real']);
  const refreshOnly = isTruthyFlag(args['refresh-only']) || isTruthyFlag(args.refresh) || isTruthyFlag(args['plan-only']);
  if (!execute && !refreshOnly) {
    throw new Error('ATR stop requires --refresh-only for read-only point refresh, or --execute-real for active stop monitoring.');
  }
  assertRealExecutionAllowed(config, execute);
  const breakevenEnabled = booleanSetting(args['breakeven-enabled'] ?? process.env.ATR_STOP_BREAKEVEN_ENABLED, true);
  const profitProtectionEnabled = booleanSetting(args['profit-protection-enabled'] ?? process.env.ATR_STOP_PROFIT_PROTECTION_ENABLED, true);
  const settings = {
    period: Math.max(1, Number(args.period || process.env.ATR_STOP_PERIOD || defaultAtrPeriod)),
    multiplier: Number(args.multiplier || process.env.ATR_STOP_MULTIPLIER || defaultAtrMultiplier),
    atrMethod: 'wilder',
    priceBasis: 'adjusted_ohlc',
    lookbackDays: Math.max(60, Number(args['lookback-days'] || process.env.ATR_STOP_LOOKBACK_DAYS || 180)),
    fallbackSeconds: Math.max(30, Number(args['fallback-seconds'] || process.env.ATR_STOP_FALLBACK_SECONDS || defaultFallbackSeconds)),
    maxInitialLossPct: pctFraction(args['max-initial-loss-pct'] ?? process.env.ATR_STOP_MAX_INITIAL_LOSS_PCT, defaultMaxInitialLossPct),
    breakevenEnabled,
    breakevenTriggerProfitPct: pctFraction(args['breakeven-trigger-profit-pct'] ?? process.env.ATR_STOP_BREAKEVEN_TRIGGER_PROFIT_PCT, defaultBreakevenTriggerProfitPct),
    breakevenFloorProfitPct: pctFraction(args['breakeven-floor-profit-pct'] ?? process.env.ATR_STOP_BREAKEVEN_FLOOR_PROFIT_PCT, defaultBreakevenFloorProfitPct),
    profitProtectionEnabled,
    profitProtectionTriggerPct: pctFraction(args['profit-protection-trigger-pct'] ?? process.env.ATR_STOP_PROFIT_PROTECTION_TRIGGER_PCT, defaultProfitProtectionTriggerPct),
    profitProtectionMaxDrawdownPct: pctFraction(args['profit-protection-max-drawdown-pct'] ?? process.env.ATR_STOP_PROFIT_PROTECTION_MAX_DRAWDOWN_PCT, defaultProfitProtectionMaxDrawdownPct),
    protectedSymbols: config.protectedStockSymbols,
  };
  settings.breakeven = {
    enabled: settings.breakevenEnabled,
    trigger_profit_pct: settings.breakevenTriggerProfitPct,
    floor_profit_pct: settings.breakevenFloorProfitPct,
  };
  settings.profitProtection = {
    enabled: settings.profitProtectionEnabled,
    trigger_profit_pct: settings.profitProtectionTriggerPct,
    max_drawdown_from_high_close_pct: settings.profitProtectionMaxDrawdownPct,
  };
  settings.orderManagement = {
    order_type: 'stop_market',
    time_in_force: 'GTC',
    regular_trading_hours_only: true,
    cancel_replace_when_stop_moves_up: true,
    do_not_lower_existing_stop_order: true,
  };
  if (!Number.isFinite(settings.multiplier) || settings.multiplier <= 0) {
    throw new Error('ATR multiplier must be a positive number.');
  }
  validatePctFraction(settings.maxInitialLossPct, 'ATR_STOP_MAX_INITIAL_LOSS_PCT');
  validatePctFraction(settings.breakevenTriggerProfitPct, 'ATR_STOP_BREAKEVEN_TRIGGER_PROFIT_PCT');
  validatePctFraction(settings.breakevenFloorProfitPct, 'ATR_STOP_BREAKEVEN_FLOOR_PROFIT_PCT');
  validatePctFraction(settings.profitProtectionTriggerPct, 'ATR_STOP_PROFIT_PROTECTION_TRIGGER_PCT');
  validatePctFraction(settings.profitProtectionMaxDrawdownPct, 'ATR_STOP_PROFIT_PROTECTION_MAX_DRAWDOWN_PCT');
  const pollSeconds = Math.max(5, Number(args['poll-seconds'] || process.env.ATR_STOP_POLL_SECONDS || 10));
  const connection = await connectMoomoo(config);
  try {
    const account = await ensureRealAccount(connection.client, config);
    await writeStatus({ phase: refreshOnly ? 'refreshing' : 'started', execute, account, poll_seconds: pollSeconds, ...settings });
    if (refreshOnly) {
      const result = await refreshAtrPoints(connection.client, config, settings);
      console.log(`[${new Date().toISOString()}] ATR refreshed positions=${result.positions} calculated=${result.calculated}`);
      return;
    }
    for (;;) {
      const result = await runCycle(connection.client, config, settings, execute);
      console.log(`[${new Date().toISOString()}] ATR stop watched=${result.watched} placed=${result.stop_orders_placed} replaced=${result.stop_orders_replaced} queued_next_open=${result.queued_next_open} next_open_submitted=${result.next_open_submitted}`);
      if (!isTruthyFlag(args.watch)) break;
      await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
    }
  } finally {
    connection.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeStatus({ phase: 'error', error: error.message });
    console.error(error);
    process.exit(1);
  });
}
