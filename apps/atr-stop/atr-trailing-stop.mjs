import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_ROOT,
  QOT_MARKET_US_SECURITY,
  TRD_ENV_REAL,
  connectMoomoo,
  createMoomooQuoteFeed,
  ensureDir,
  fetchMoomooAccounts,
  fetchOrderFillList,
  fetchOrderList,
  fetchPositionList,
  loadMoomooConfig,
  maskId,
  normalizeForJson,
  parseCliArgs,
  placeLimitSellOrder,
  placeMarketSellOrder,
  requestHistoryKL,
  selectConfiguredUsRealAccount,
} from '../../packages/moomoo-opend/moomoo-opend.mjs';

const args = parseCliArgs();
const logsDir = path.join(PROJECT_ROOT, 'logs');
const statusPath = path.join(logsDir, 'atr-stop-status.json');
const statePath = path.join(logsDir, 'atr-stop-state.json');
const ordersPath = path.join(logsDir, 'atr-stop-orders.ndjson');
const defaultAtrPeriod = 21;
const defaultAtrMultiplier = 3.5;
const defaultLimitBufferPct = 0.35;
const defaultFallbackSeconds = 45;

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMoney(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function roundPct(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(4)) : null;
}

function roundPrice(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(4)) : null;
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
  const atr = calculateAtrWilder(bars, period);
  const latest = bars[bars.length - 1];
  const closeSinceEntry = String(position.entry_date || '')
    ? bars.filter((bar) => bar.date >= String(position.entry_date)).map((bar) => numeric(bar.close)).filter((value) => value !== null)
    : [];
  const historicalHighestClose = closeSinceEntry.length > 0 ? Math.max(...closeSinceEntry) : null;
  const highestClose = Math.max(
    numeric(position.highest_close_since_entry) ?? historicalHighestClose ?? numeric(position.entry_price) ?? latest.close,
    latest.close,
  );
  const candidateStop = highestClose - multiplier * atr;
  const previousStop = numeric(position.current_stop_price);
  const currentStop = previousStop === null ? candidateStop : Math.max(previousStop, candidateStop);
  return {
    ...position,
    highest_close_since_entry: Number(highestClose.toFixed(4)),
    current_atr: atr,
    atr_points: atr,
    current_stop_price: Number(currentStop.toFixed(4)),
    last_update_date: latest.date,
    status: position.status === 'PENDING_SELL' || position.status === 'SOLD' ? position.status : 'HELD',
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
  const status = previous?.status === 'PENDING_SELL' || previous?.status === 'SOLD' ? previous.status : 'HELD';
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
    last_update_date: previous?.last_update_date || '',
    status,
    error: previous?.error || null,
    updated_at: new Date().toISOString(),
  };
}

async function refreshAtrState(client, config, state, settings) {
  const response = await fetchPositionList(client, config);
  const positions = normalizeStockPositions(normalizeForJson(response).s2c?.positionList || []);
  const currentSymbols = new Set(positions.map((position) => position.symbol));

  for (const [symbol, previous] of Object.entries(state.positions || {})) {
    if (!currentSymbols.has(symbol) && previous.status !== 'SOLD') {
      state.positions[symbol] = {
        ...previous,
        status: previous.status === 'PENDING_SELL' ? 'SOLD' : previous.status,
        shares: 0,
        can_sell_qty: 0,
        sold_reason: previous.status === 'PENDING_SELL' ? 'POSITION_NOT_FOUND_AFTER_SELL' : previous.sold_reason,
        sold_time: previous.status === 'PENDING_SELL' ? new Date().toISOString() : previous.sold_time,
        updated_at: new Date().toISOString(),
      };
    }
  }

  for (const row of positions) {
    const previous = state.positions[row.symbol] || null;
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

function quotePrice(snapshot) {
  const basic = snapshot?.basic || {};
  return numeric(basic.curPrice) ?? numeric(basic.lastClosePrice) ?? numeric(basic.openPrice);
}

function quoteTick(snapshot) {
  return numeric(snapshot?.basic?.priceSpread) ?? 0.01;
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

async function monitorStops(client, config, quoteFeed, state, execute, settings) {
  const held = Object.values(state.positions || {})
    .filter((position) => position.status === 'HELD' && numeric(position.current_stop_price) !== null && position.shares > 0);
  if (held.length === 0) return { watched: 0, triggered: 0, submitted: 0 };

  const result = await quoteFeed.getSnapshots(held.map((position) => stockSecurity(position.symbol)), {
    orderBookSecurities: [],
  });
  let triggered = 0;
  let submitted = 0;
  for (const position of held) {
    const snapshot = (result.snapshots || []).find((item) => normalizeSymbol(item?.basic?.security?.code) === position.symbol);
    const price = quotePrice(snapshot);
    const withRisk = attachRiskMetrics(position, price, snapshot);
    state.positions[position.symbol] = withRisk;
    if (price === null || price > Number(position.current_stop_price)) continue;
    triggered += 1;
    const qty = Math.min(Math.floor(withRisk.shares), Math.floor(withRisk.can_sell_qty));
    const limitPrice = marketableStopLimitPrice(price, {
      bufferPct: settings.limitBufferPct,
      tick: quoteTick(snapshot),
    });
    const trigger = {
      reason: 'ATR_TRAILING_STOP_TRIGGERED',
      symbol: withRisk.symbol,
      realtime_price: price,
      stop_price: withRisk.current_stop_price,
      shares: qty,
      triggered_at: new Date().toISOString(),
      distance_to_stop_pct: withRisk.distance_to_stop_pct,
      quote: normalizeForJson(snapshot?.basic || null),
    };
    if (qty <= 0) {
      state.positions[withRisk.symbol] = {
        ...withRisk,
        status: 'PENDING_SELL',
        last_trigger: trigger,
        error: 'NO_SELLABLE_SHARES',
        updated_at: new Date().toISOString(),
      };
      continue;
    }
    if (!execute) {
      state.positions[withRisk.symbol] = {
        ...withRisk,
        status: 'PENDING_SELL',
        last_trigger: trigger,
        pending_order_status: 'not_submitted_execute_disabled',
        updated_at: new Date().toISOString(),
      };
      continue;
    }

    const payload = {
      submitted_at: new Date().toISOString(),
      business_line: 'atr_trailing_stop',
      side: 'SELL',
      symbol: withRisk.symbol,
      qty,
      order_type: 'MARKETABLE_LIMIT',
      limit_price: limitPrice,
      fallback_after_seconds: settings.fallbackSeconds,
      trigger,
    };
    try {
      if (limitPrice === null) throw new Error('INVALID_MARKETABLE_LIMIT_PRICE');
      const response = await placeLimitSellOrder(client, config, {
        code: withRisk.symbol,
        qty,
        price: limitPrice,
        remark: 'ATR_TRAILING_STOP',
        positionID: withRisk.position_id,
      });
      payload.status = 'submitted';
      payload.response = normalizeForJson(response);
      submitted += 1;
      state.positions[withRisk.symbol] = {
        ...withRisk,
        status: 'PENDING_SELL',
        last_trigger: trigger,
        sell_order_type: 'MARKETABLE_LIMIT',
        sell_limit_price: limitPrice,
        sell_qty: qty,
        sell_order_id_ex: String(response.s2c?.orderIDEx || ''),
        sell_order_id_exes: [String(response.s2c?.orderIDEx || '')].filter(Boolean),
        sell_submitted_at: payload.submitted_at,
        pending_since: payload.submitted_at,
        fallback_after_seconds: settings.fallbackSeconds,
        updated_at: new Date().toISOString(),
      };
    } catch (error) {
      payload.status = 'submit_failed';
      payload.error = error.message;
      state.positions[withRisk.symbol] = {
        ...withRisk,
        status: 'HELD',
        last_trigger: trigger,
        error: error.message,
        updated_at: new Date().toISOString(),
      };
    }
    await appendOrder(payload);
  }
  return { watched: held.length, triggered, submitted };
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

async function runCycle(client, config, quoteFeed, settings, execute) {
  const state = loadState();
  const positions = await refreshAtrState(client, config, state, settings);
  const pending = await refreshPendingSells(client, config, state, positions, settings, execute);
  const monitor = await monitorStops(client, config, quoteFeed, state, execute, settings);
  await writeState(state);
  await writeStatus({
    phase: 'ok',
    execute,
    atr_period: settings.period,
    atr_multiplier: settings.multiplier,
    marketable_limit_buffer_pct: settings.limitBufferPct,
    fallback_seconds: settings.fallbackSeconds,
    positions: positions.length,
    pending_sells: pending.pending,
    sold_this_cycle: pending.sold,
    fallback_submitted: pending.fallback_submitted,
    watched: monitor.watched,
    triggered: monitor.triggered,
    submitted: monitor.submitted,
    state_path: path.relative(PROJECT_ROOT, statePath),
    orders_path: path.relative(PROJECT_ROOT, ordersPath),
  });
  return monitor;
}

async function main() {
  const config = loadMoomooConfig({ envFile: args.env });
  const execute = isTruthyFlag(args['execute-real']);
  if (!execute) {
    throw new Error('ATR stop requires --execute-real because this business line is an active real-account stop program.');
  }
  assertRealExecutionAllowed(config, execute);
  const settings = {
    period: Math.max(1, Number(args.period || process.env.ATR_STOP_PERIOD || defaultAtrPeriod)),
    multiplier: Number(args.multiplier || process.env.ATR_STOP_MULTIPLIER || defaultAtrMultiplier),
    lookbackDays: Math.max(60, Number(args['lookback-days'] || process.env.ATR_STOP_LOOKBACK_DAYS || 180)),
    limitBufferPct: Number(args['limit-buffer-pct'] || process.env.ATR_STOP_LIMIT_BUFFER_PCT || defaultLimitBufferPct),
    fallbackSeconds: Math.max(30, Number(args['fallback-seconds'] || process.env.ATR_STOP_FALLBACK_SECONDS || defaultFallbackSeconds)),
  };
  if (!Number.isFinite(settings.multiplier) || settings.multiplier <= 0) {
    throw new Error('ATR multiplier must be a positive number.');
  }
  if (!Number.isFinite(settings.limitBufferPct) || settings.limitBufferPct < 0) {
    throw new Error('ATR stop limit buffer must be zero or a positive number.');
  }
  const pollSeconds = Math.max(5, Number(args['poll-seconds'] || process.env.ATR_STOP_POLL_SECONDS || 10));
  const connection = await connectMoomoo(config);
  const quoteFeed = createMoomooQuoteFeed(connection.client, config);
  try {
    const account = await ensureRealAccount(connection.client, config);
    await writeStatus({ phase: 'started', execute, account, poll_seconds: pollSeconds, ...settings });
    for (;;) {
      const result = await runCycle(connection.client, config, quoteFeed, settings, execute);
      console.log(`[${new Date().toISOString()}] ATR stop watched=${result.watched} triggered=${result.triggered} submitted=${result.submitted}`);
      if (!isTruthyFlag(args.watch)) break;
      await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
    }
  } finally {
    await quoteFeed.close();
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
