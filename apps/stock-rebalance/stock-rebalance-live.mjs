import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_ROOT,
  QOT_MARKET_US_SECURITY,
  TRD_CURRENCY_USD,
  TRD_ENV_REAL,
  connectMoomoo,
  createMoomooQuoteFeed,
  ensureDir,
  fetchFunds,
  fetchMoomooAccounts,
  fetchOrderList,
  fetchPositionList,
  loadMoomooConfig,
  maskId,
  normalizeForJson,
  parseCliArgs,
  placeLimitBuyOrder,
  placeLimitSellOrder,
  placeMarketBuyOrder,
  placeMarketSellOrder,
  SESSION_RTH,
  selectConfiguredUsRealAccount,
} from '../../packages/moomoo-opend/moomoo-opend.mjs';

const args = parseCliArgs();
const logsDir = path.join(PROJECT_ROOT, 'logs');
export const defaultTargetsPath = path.join(PROJECT_ROOT, 'stock-rebalance-targets.csv');
const statusPath = path.join(logsDir, 'stock-rebalance-status.json');
const latestPlanPath = path.join(logsDir, 'stock-rebalance-plan-latest.json');
const ordersPath = path.join(logsDir, 'stock-rebalance-orders.ndjson');
const DEFAULT_SELL_PHASE_TIMEOUT_SECONDS = 120;
const DEFAULT_STOCK_LIMIT_TICK = 0.01;

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstProvided(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function percentValue(value, name, defaultValue = 100) {
  const raw = firstProvided(value, defaultValue);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${name} must be a percentage between 0 and 100.`);
  }
  return parsed;
}

function isTruthyFlag(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function hasArg(name) {
  return Object.prototype.hasOwnProperty.call(args, name);
}

function sessionLooksOutsideRth(value) {
  if (value === undefined || value === null || value === '') return false;
  const normalized = String(value).trim().toLowerCase();
  return !['1', 'rth', 'regular', 'regular_hours', 'regular-hours'].includes(normalized);
}

function stockOrderOverridesFromArgs() {
  const extendedHours = isTruthyFlag(args['extended-hours']) || isTruthyFlag(args.premarket) || isTruthyFlag(args['pre-market']);
  const session = args.session || args['order-session'] || (extendedHours ? 'eth' : undefined);
  const fillOutsideRTH = hasArg('fill-outside-rth')
    ? isTruthyFlag(args['fill-outside-rth'])
    : (extendedHours || sessionLooksOutsideRth(session) ? true : undefined);
  return {
    stockOrderSession: session,
    stockFillOutsideRTH: fillOutsideRTH,
    stockLimitBufferPct: args['limit-buffer-pct'],
  };
}

function stockTargetInvestedPctFromArgs() {
  return percentValue(
    firstProvided(
      args['target-invested-pct'],
      args['invested-pct'],
      process.env.STOCK_REBALANCE_TARGET_INVESTED_PCT,
      process.env.MOOMOO_STOCK_TARGET_INVESTED_PCT,
    ),
    'STOCK_REBALANCE_TARGET_INVESTED_PCT',
    100,
  );
}

function normalizeStockOrderConfig(config) {
  const fillOverridePresent = hasArg('fill-outside-rth')
    || process.env.STOCK_REBALANCE_FILL_OUTSIDE_RTH !== undefined
    || process.env.MOOMOO_STOCK_FILL_OUTSIDE_RTH !== undefined;
  if (Number(config.stockOrderSession) !== SESSION_RTH && !fillOverridePresent) {
    config.stockFillOutsideRTH = true;
  }
  return config;
}

export function shouldUseExtendedHoursLimitOrders(config = {}) {
  return Number(config.stockOrderSession) !== SESSION_RTH || Boolean(config.stockFillOutsideRTH);
}

function stockOrderMode(config = {}) {
  return {
    order_type: shouldUseExtendedHoursLimitOrders(config) ? 'LIMIT' : 'MARKET',
    order_session: Number(config.stockOrderSession ?? SESSION_RTH),
    fill_outside_rth: Boolean(config.stockFillOutsideRTH),
    limit_buffer_pct: shouldUseExtendedHoursLimitOrders(config) ? Number(config.stockLimitBufferPct ?? 0.25) : null,
  };
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

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (ch === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

export function parseTargetsCsv(text) {
  const rows = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (rows.length < 2) throw new Error('stock target CSV must contain a header and 5 target rows.');
  const header = parseCsvLine(rows[0]).map((cell) => cell.toLowerCase());
  const symbolIndex = header.indexOf('symbol');
  const pctIndex = header.indexOf('target_pct');
  if (symbolIndex < 0) throw new Error('stock target CSV must include a symbol column.');

  const targets = [];
  const seen = new Set();
  for (const line of rows.slice(1)) {
    const cells = parseCsvLine(line);
    const symbol = normalizeSymbol(cells[symbolIndex]);
    if (!symbol) continue;
    if (!isStockSymbol(symbol)) throw new Error(`Invalid US stock symbol in target CSV: ${symbol}`);
    if (seen.has(symbol)) throw new Error(`Duplicate stock symbol in target CSV: ${symbol}`);
    seen.add(symbol);
    targets.push({
      symbol,
      target_pct: numeric(cells[pctIndex]) ?? null,
    });
  }
  if (targets.length !== 5) throw new Error(`stock rebalance requires exactly 5 target symbols; found ${targets.length}.`);

  const explicitTotal = targets.reduce((sum, row) => sum + (row.target_pct ?? 0), 0);
  if (explicitTotal > 0) {
    return targets.map((row) => ({
      symbol: row.symbol,
      target_pct: Number(((row.target_pct ?? 0) / explicitTotal * 100).toFixed(6)),
    }));
  }
  return targets.map((row) => ({ symbol: row.symbol, target_pct: 20 }));
}

function loadTargets(filePath) {
  const resolved = path.resolve(filePath || defaultTargetsPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Missing stock target CSV: ${resolved}`);
  }
  return {
    file: resolved,
    targets: parseTargetsCsv(fs.readFileSync(resolved, 'utf8')),
  };
}

function stockSecurity(symbol) {
  return { market: QOT_MARKET_US_SECURITY, code: normalizeSymbol(symbol) };
}

function stockCodeFromPosition(position) {
  return normalizeSymbol(position?.code);
}

function normalizeStockPositions(positionList) {
  const out = [];
  for (const raw of positionList || []) {
    const symbol = stockCodeFromPosition(raw);
    const qty = Math.floor(numeric(raw.qty) ?? 0);
    if (!isStockSymbol(symbol) || qty <= 0) continue;
    out.push({
      symbol,
      qty,
      can_sell_qty: Math.floor(numeric(raw.canSellQty) ?? qty),
      price: numeric(raw.price),
      market_value: numeric(raw.val),
      position_id: raw.positionID,
      raw: normalizeForJson(raw),
    });
  }
  return out;
}

function fundsCash(funds) {
  return numeric(funds?.cash) ?? numeric(funds?.availableFunds) ?? 0;
}

function quotePrice(snapshot) {
  const basic = snapshot?.basic || {};
  return numeric(basic.curPrice) ?? numeric(basic.lastClosePrice) ?? numeric(basic.openPrice);
}

function quoteBid(snapshot) {
  return numeric(snapshot?.basic?.bidPrice);
}

function quoteAsk(snapshot) {
  return numeric(snapshot?.basic?.askPrice);
}

function quotePriceSpread(snapshot) {
  return numeric(snapshot?.basic?.priceSpread) ?? DEFAULT_STOCK_LIMIT_TICK;
}

function positionValue(position, price) {
  const px = numeric(price) ?? numeric(position.price);
  if (px !== null) return position.qty * px;
  const value = numeric(position.market_value);
  if (value !== null && value >= 0) return value;
  return 0;
}

function quoteForSymbol(quoteMap, symbol) {
  return quoteMap.get(normalizeSymbol(symbol)) || {};
}

function targetRowStockValue(row, qty = row.desired_qty) {
  return (numeric(qty) ?? 0) * (numeric(row.price) ?? 0);
}

function optimizeTargetRowsForBudget(rows, targetStockBudget) {
  const budget = numeric(targetStockBudget);
  if (budget === null || budget <= 0) return rows;

  const baseRows = rows.map((row) => ({ ...row }));
  const baseValue = baseRows.reduce((sum, row) => sum + targetRowStockValue(row), 0);
  const remainingBudget = budget - baseValue;
  if (remainingBudget <= 0) return baseRows;

  const candidateLists = baseRows.map((row) => {
    const price = numeric(row.price);
    if (row.protected || price === null || price <= 0) return [row.desired_qty];
    const maxExtra = Math.min(25, Math.floor(remainingBudget / price));
    return Array.from({ length: maxExtra + 1 }, (_, index) => row.desired_qty + index);
  });

  let bestQuantities = baseRows.map((row) => row.desired_qty);
  let bestStockValue = baseValue;
  let bestWeightDeviation = baseRows.reduce((sum, row) => sum + Math.abs(targetRowStockValue(row) - row.target_value), 0);
  const quantities = [];

  function visit(index, stockValue) {
    if (stockValue > budget + 1e-6) return;
    if (index === baseRows.length) {
      const weightDeviation = baseRows.reduce((sum, row, rowIndex) => (
        sum + Math.abs(targetRowStockValue(row, quantities[rowIndex]) - row.target_value)
      ), 0);
      const closerToBudget = stockValue > bestStockValue + 1e-6;
      const sameBudgetBetterWeights = Math.abs(stockValue - bestStockValue) <= 1e-6
        && weightDeviation < bestWeightDeviation - 1e-6;
      if (closerToBudget || sameBudgetBetterWeights) {
        bestStockValue = stockValue;
        bestWeightDeviation = weightDeviation;
        bestQuantities = quantities.slice();
      }
      return;
    }

    const row = baseRows[index];
    const price = numeric(row.price) ?? 0;
    for (const qty of candidateLists[index]) {
      quantities[index] = qty;
      visit(index + 1, stockValue + qty * price);
    }
  }

  visit(0, 0);

  return baseRows.map((row, index) => {
    const desiredQty = bestQuantities[index];
    const optimizedValue = targetRowStockValue(row, desiredQty);
    return {
      ...row,
      desired_qty: desiredQty,
      delta_qty: row.protected ? 0 : desiredQty - row.current_qty,
      optimized_value: Number(optimizedValue.toFixed(2)),
    };
  });
}

export function buildRebalancePlan({
  targets,
  positions,
  funds,
  quotes,
  protectedSymbols = [],
  orderType = 'MARKET',
  targetInvestedPct = 100,
  generatedAt = new Date().toISOString(),
}) {
  const targetSymbols = new Set(targets.map((row) => row.symbol));
  const quoteMap = quotes instanceof Map ? quotes : new Map(Object.entries(quotes || {}));
  const protectedSet = new Set(protectedSymbols.map((symbol) => normalizeSymbol(symbol)).filter(Boolean));
  const activePositions = positions.filter((position) => !protectedSet.has(position.symbol));
  const currentBySymbol = new Map();
  for (const position of positions) currentBySymbol.set(position.symbol, position);

  const cash = fundsCash(funds);
  const stockValue = activePositions.reduce((sum, position) => {
    const quote = quoteForSymbol(quoteMap, position.symbol);
    return sum + positionValue(position, quote.price);
  }, 0);
  const portfolioValue = cash + stockValue;
  const investedPct = percentValue(targetInvestedPct, 'targetInvestedPct', 100);
  const targetStockBudget = portfolioValue * investedPct / 100;
  const targetCashReserve = portfolioValue - targetStockBudget;
  let targetRows = targets.map((target) => {
    const protectedTarget = protectedSet.has(target.symbol);
    const current = currentBySymbol.get(target.symbol) || { symbol: target.symbol, qty: 0, can_sell_qty: 0 };
    const quote = quoteForSymbol(quoteMap, target.symbol);
    const price = numeric(quote.price) ?? numeric(current.price);
    const bid = numeric(quote.bid);
    const ask = numeric(quote.ask);
    const priceSpread = numeric(quote.price_spread) ?? DEFAULT_STOCK_LIMIT_TICK;
    const targetValue = targetStockBudget * target.target_pct / 100;
    const currentQty = Math.floor(current.qty || 0);
    const desiredQty = protectedTarget ? currentQty : (price && price > 0 ? Math.floor(targetValue / price) : 0);
    const deltaQty = protectedTarget ? 0 : desiredQty - currentQty;
    return {
      symbol: target.symbol,
      target_pct: target.target_pct,
      protected: protectedTarget,
      target_value: protectedTarget ? Number(positionValue(current, price).toFixed(2)) : Number(targetValue.toFixed(2)),
      price,
      bid,
      ask,
      price_spread: priceSpread,
      current_qty: currentQty,
      desired_qty: desiredQty,
      delta_qty: deltaQty,
      current_value: Number(positionValue(current, price).toFixed(2)),
      position_id: current.position_id,
      can_sell_qty: Math.floor(current.can_sell_qty || 0),
    };
  });
  targetRows = optimizeTargetRowsForBudget(targetRows, targetStockBudget);

  const orders = [];
  for (const position of activePositions) {
    if (!targetSymbols.has(position.symbol)) {
      const qty = Math.min(Math.floor(position.qty), Math.floor(position.can_sell_qty));
      const quote = quoteForSymbol(quoteMap, position.symbol);
      const price = numeric(quote.price) ?? numeric(position.price);
      if (qty > 0) {
        orders.push({
          side: 'SELL',
          symbol: position.symbol,
          qty,
          order_type: orderType,
          reason: 'not_in_target_sheet',
          position_id: position.position_id,
          reference_price: price,
          bid: numeric(quote.bid),
          ask: numeric(quote.ask),
          price_spread: numeric(quote.price_spread) ?? DEFAULT_STOCK_LIMIT_TICK,
        });
      }
    }
  }
  for (const row of targetRows) {
    if (row.delta_qty < 0) {
      const qty = Math.min(Math.abs(row.delta_qty), row.can_sell_qty);
      if (qty > 0) {
        orders.push({
          side: 'SELL',
          symbol: row.symbol,
          qty,
          order_type: orderType,
          reason: 'rebalance_overweight',
          position_id: row.position_id,
          reference_price: row.price,
          bid: row.bid,
          ask: row.ask,
          price_spread: row.price_spread,
        });
      }
    }
  }
  for (const row of targetRows) {
    if (row.delta_qty > 0 && row.price > 0) {
      orders.push({
        side: 'BUY',
        symbol: row.symbol,
        qty: row.delta_qty,
        order_type: orderType,
        reason: 'rebalance_underweight',
        reference_price: row.price,
        bid: row.bid,
        ask: row.ask,
        price_spread: row.price_spread,
      });
    }
  }

  return {
    generated_at: generatedAt,
    mode: 'stock_rebalance_live',
    cash: Number(cash.toFixed(2)),
    stock_value: Number(stockValue.toFixed(2)),
    portfolio_value: Number(portfolioValue.toFixed(2)),
    target_invested_pct: Number(investedPct.toFixed(6)),
    target_cash_pct: Number((100 - investedPct).toFixed(6)),
    target_stock_budget: Number(targetStockBudget.toFixed(2)),
    target_cash_reserve: Number(targetCashReserve.toFixed(2)),
    target_count: targets.length,
    targets: targetRows,
    protected_symbols: [...protectedSet],
    protected_positions: positions
      .filter((position) => protectedSet.has(position.symbol))
      .map((position) => ({
        symbol: position.symbol,
        qty: position.qty,
        can_sell_qty: position.can_sell_qty,
        market_value: position.market_value,
        position_id: position.position_id,
        reason: 'protected_stock_symbol',
      })),
    off_sheet_positions: activePositions
      .filter((position) => !targetSymbols.has(position.symbol))
      .map((position) => ({
        symbol: position.symbol,
        qty: position.qty,
        can_sell_qty: position.can_sell_qty,
        market_value: position.market_value,
        position_id: position.position_id,
      })),
    orders,
  };
}

function roundUpToTick(value, tick) {
  const step = Number.isFinite(tick) && tick > 0 ? tick : DEFAULT_STOCK_LIMIT_TICK;
  return Number((Math.ceil((value - Number.EPSILON) / step) * step).toFixed(4));
}

function roundDownToTick(value, tick) {
  const step = Number.isFinite(tick) && tick > 0 ? tick : DEFAULT_STOCK_LIMIT_TICK;
  return Number((Math.floor((value + Number.EPSILON) / step) * step).toFixed(4));
}

export function stockLimitPriceForOrder(order, bufferPct = 0.25) {
  const side = String(order?.side || '').toUpperCase();
  if (!['BUY', 'SELL'].includes(side)) throw new Error(`Unsupported stock order side for limit price: ${order?.side || ''}`);
  const tick = Math.max(0.001, numeric(order?.price_spread) ?? DEFAULT_STOCK_LIMIT_TICK);
  const fallback = numeric(order?.reference_price) ?? numeric(order?.price);
  const base = side === 'BUY'
    ? (numeric(order?.ask) ?? fallback)
    : (numeric(order?.bid) ?? fallback);
  if (base === null || base <= 0) {
    throw new Error(`Missing positive reference price for ${side} ${order?.symbol || ''} limit order.`);
  }
  const buffer = Math.max(0, numeric(bufferPct) ?? 0);
  const raw = side === 'BUY' ? base * (1 + buffer / 100) : base * (1 - buffer / 100);
  const rounded = side === 'BUY' ? roundUpToTick(raw, tick) : roundDownToTick(raw, tick);
  return Math.max(tick, rounded);
}

async function writeStatus(payload) {
  await ensureDir(path.dirname(statusPath));
  await fsp.writeFile(statusPath, `${JSON.stringify({ updated_at: new Date().toISOString(), ...payload }, null, 2)}\n`, 'utf8');
}

async function writeLatestPlan(plan) {
  await ensureDir(path.dirname(latestPlanPath));
  await fsp.writeFile(latestPlanPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
}

async function appendOrder(payload) {
  await ensureDir(path.dirname(ordersPath));
  await fsp.appendFile(ordersPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

export function splitRebalanceOrders(orders = []) {
  const sellOrders = [];
  const buyOrders = [];
  for (const order of orders || []) {
    const side = String(order?.side || '').toUpperCase();
    if (side === 'SELL') sellOrders.push(order);
    else if (side === 'BUY') buyOrders.push(order);
  }
  return { sellOrders, buyOrders };
}

function brokerOrderIdEx(response) {
  return String(response?.s2c?.orderIDEx || '');
}

function brokerOrderId(response) {
  const id = response?.s2c?.orderID;
  return id === undefined || id === null || id === '' ? null : id;
}

function findOrderByIdEx(orderList, orderIDEx) {
  const id = String(orderIDEx || '');
  if (!id) return null;
  return (orderList || []).find((order) => String(order?.orderIDEx || '') === id) || null;
}

export function isFilledOrderStatus(status) {
  return Number(status) === 11;
}

export function isTerminalUnfilledOrderStatus(status) {
  return [3, 14, 15, 21, 22, 23, 24].includes(Number(status));
}

function shortBrokerOrder(row) {
  if (!row) return null;
  return {
    order_id_ex: String(row.orderIDEx || ''),
    order_status: row.orderStatus ?? null,
    fill_qty: numeric(row.fillQty) ?? 0,
    fill_avg_price: numeric(row.fillAvgPrice) ?? null,
    last_error: row.lastErrMsg || '',
  };
}

export function summarizeSellPhase(submittedSellOrders = [], brokerOrders = []) {
  const orders = (submittedSellOrders || []).map((submitted) => {
    const requiredQty = Math.max(0, Math.floor(numeric(submitted?.qty) ?? 0));
    if (submitted?.status !== 'submitted') {
      return {
        order_id_ex: submitted?.order_id_ex || '',
        symbol: submitted?.symbol || '',
        qty: requiredQty,
        submitted_status: submitted?.status || 'unknown',
        broker_order: null,
        fill_qty: 0,
        complete: false,
        terminal_unfilled: false,
        open: false,
        failure_reason: submitted?.error || 'submit_failed',
      };
    }
    const brokerOrder = findOrderByIdEx(brokerOrders, submitted.order_id_ex);
    const fillQty = Math.floor(numeric(brokerOrder?.fillQty) ?? 0);
    const orderStatus = brokerOrder?.orderStatus ?? null;
    const complete = requiredQty > 0 && (fillQty >= requiredQty || isFilledOrderStatus(orderStatus));
    const terminalUnfilled = !complete && isTerminalUnfilledOrderStatus(orderStatus);
    return {
      order_id_ex: submitted.order_id_ex || '',
      symbol: submitted.symbol || '',
      qty: requiredQty,
      submitted_status: submitted.status,
      broker_order: shortBrokerOrder(brokerOrder),
      fill_qty: fillQty,
      complete,
      terminal_unfilled: terminalUnfilled,
      open: !complete && !terminalUnfilled,
      failure_reason: terminalUnfilled ? 'sell_order_terminal_before_full_fill' : '',
    };
  });
  const completeCount = orders.filter((order) => order.complete).length;
  const failedCount = orders.filter((order) => order.failure_reason).length;
  const openCount = orders.filter((order) => order.open).length;
  return {
    total: orders.length,
    complete_count: completeCount,
    failed_count: failedCount,
    open_count: openCount,
    all_complete: orders.length === completeCount,
    orders,
  };
}

export function shouldProceedToBuyPhase(sellPhase) {
  return Boolean(sellPhase && sellPhase.all_complete);
}

function assertRealAccountAllowed(config, execute) {
  config.trdEnv = TRD_ENV_REAL;
  if (!execute) return;
  if (!config.allowRealTrading) {
    throw new Error('Real stock rebalance is blocked. Set MOOMOO_ALLOW_REAL_TRADING=true in .env first.');
  }
  if (String(process.env.MOOMOO_REAL_TRADING_CONFIRM || '') !== 'I_UNDERSTAND') {
    throw new Error('Real stock rebalance is blocked. Set MOOMOO_REAL_TRADING_CONFIRM=I_UNDERSTAND for the started process.');
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

function nyParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const out = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: out.weekday,
    hour: Number(out.hour === '24' ? '0' : out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

function isWeekday(parts) {
  return !['Sat', 'Sun'].includes(parts.weekday);
}

export function isRegularSessionNow(date = new Date()) {
  const parts = nyParts(date);
  const minutes = parts.hour * 60 + parts.minute;
  return isWeekday(parts) && minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
}

async function waitForRegularOpen(pollSeconds) {
  while (!isRegularSessionNow()) {
    const parts = nyParts();
    await writeStatus({
      phase: 'waiting_for_regular_open',
      new_york_time: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`,
      poll_seconds: pollSeconds,
      latest_plan_path: path.relative(PROJECT_ROOT, latestPlanPath),
    });
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }
}

async function quoteSymbols(quoteFeed, symbols, config) {
  const securities = symbols.map(stockSecurity);
  const needsOrderBook = shouldUseExtendedHoursLimitOrders(config);
  const result = await quoteFeed.getSnapshots(securities, {
    orderBookSecurities: needsOrderBook ? securities : [],
    warmupMs: config.quotePushWarmupMs,
  });
  const out = new Map();
  for (const snapshot of result.snapshots || []) {
    const symbol = normalizeSymbol(snapshot?.basic?.security?.code);
    if (!symbol) continue;
    out.set(symbol, {
      price: quotePrice(snapshot),
      bid: quoteBid(snapshot),
      ask: quoteAsk(snapshot),
      price_spread: quotePriceSpread(snapshot),
      basic: normalizeForJson(snapshot?.basic || null),
      order_book: normalizeForJson(snapshot?.order_book || null),
      quote_source: snapshot?.quote_source || null,
      quote_received_at: snapshot?.quote_received_at || null,
      bid_ask_source: snapshot?.bid_ask_source || null,
      bid_ask_received_at: snapshot?.bid_ask_received_at || null,
    });
  }
  return out;
}

async function createPlan({ client, quoteFeed, config, targets }) {
  const positionsResponse = await fetchPositionList(client, config);
  const fundsResponse = await fetchFunds(client, config, { currency: TRD_CURRENCY_USD });
  const positions = normalizeStockPositions(normalizeForJson(positionsResponse).s2c?.positionList || []);
  const symbols = [...new Set([
    ...targets.map((target) => target.symbol),
    ...positions.map((position) => position.symbol),
  ])];
  const quotes = await quoteSymbols(quoteFeed, symbols, config);
  const plan = buildRebalancePlan({
    targets,
    positions,
    funds: normalizeForJson(fundsResponse).s2c?.funds || {},
    quotes,
    protectedSymbols: config.protectedStockSymbols,
    orderType: stockOrderMode(config).order_type,
    targetInvestedPct: config.stockTargetInvestedPct,
  });
  plan.account = { accID: maskId(config.accId), trdEnv: config.trdEnv };
  plan.order_submission = stockOrderMode(config);
  return plan;
}

async function submitOrders(client, config, orders, executionPhase) {
  const submitted = [];
  const orderMode = stockOrderMode(config);
  const orderOptions = {
    session: orderMode.order_session,
    fillOutsideRTH: orderMode.fill_outside_rth,
  };
  for (const order of orders) {
    const payload = {
      submitted_at: new Date().toISOString(),
      business_line: 'stock_rebalance_live',
      execution_phase: executionPhase,
      side: order.side,
      symbol: order.symbol,
      qty: order.qty,
      planned_order_type: order.order_type,
      order_type: orderMode.order_type,
      order_session: orderMode.order_session,
      fill_outside_rth: orderMode.fill_outside_rth,
      reason: order.reason,
    };
    try {
      const request = {
        code: order.symbol,
        qty: order.qty,
        remark: `rebalance:${order.reason}`.slice(0, 60),
        positionID: order.position_id,
      };
      let response;
      if (orderMode.order_type === 'LIMIT') {
        request.price = stockLimitPriceForOrder(order, orderMode.limit_buffer_pct);
        payload.limit_price = request.price;
        payload.limit_buffer_pct = orderMode.limit_buffer_pct;
        response = order.side === 'BUY'
          ? await placeLimitBuyOrder(client, config, request, orderOptions)
          : await placeLimitSellOrder(client, config, request, orderOptions);
      } else {
        response = order.side === 'BUY'
          ? await placeMarketBuyOrder(client, config, request)
          : await placeMarketSellOrder(client, config, request);
      }
      payload.status = 'submitted';
      payload.order_id_ex = brokerOrderIdEx(response);
      payload.order_id = brokerOrderId(response);
      payload.response = normalizeForJson(response);
    } catch (error) {
      payload.status = 'submit_failed';
      payload.error = error.message;
    }
    submitted.push(payload);
    await appendOrder(payload);
  }
  return submitted;
}

async function fetchBrokerOrders(client, config) {
  return normalizeForJson((await fetchOrderList(client, config)).s2c?.orderList || []);
}

async function waitForSellPhase(client, config, submittedSellOrders, opts = {}) {
  const timeoutMs = Math.max(1, Number(opts.timeoutSeconds ?? DEFAULT_SELL_PHASE_TIMEOUT_SECONDS)) * 1000;
  const pollSeconds = Math.max(1, Number(opts.pollSeconds ?? 2));
  const startedAt = Date.now();
  let summary = summarizeSellPhase(submittedSellOrders, []);
  if (submittedSellOrders.length === 0 || !summary.open_count) return summary;

  while (Date.now() - startedAt <= timeoutMs) {
    const brokerOrders = await fetchBrokerOrders(client, config);
    summary = summarizeSellPhase(submittedSellOrders, brokerOrders);
    if (typeof opts.onPoll === 'function') await opts.onPoll(summary);
    if (summary.all_complete || summary.failed_count > 0 || summary.open_count === 0) return summary;
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }

  const brokerOrders = await fetchBrokerOrders(client, config);
  summary = summarizeSellPhase(submittedSellOrders, brokerOrders);
  return {
    ...summary,
    timed_out: summary.open_count > 0,
  };
}

async function executeSellThenBuy({ client, quoteFeed, config, targets, executionPlan, targetFile, account, pollSeconds, sellPhaseTimeoutSeconds }) {
  const { sellOrders } = splitRebalanceOrders(executionPlan.orders);
  await writeStatus({
    phase: 'sell_phase_submitting',
    target_file: targetFile,
    planned_sell_orders: sellOrders.length,
    planned_buy_orders: splitRebalanceOrders(executionPlan.orders).buyOrders.length,
    target_invested_pct: config.stockTargetInvestedPct,
    order_submission: stockOrderMode(config),
    account,
  });
  const submittedSells = await submitOrders(client, config, sellOrders, 'sell_phase');
  const sellPhase = await waitForSellPhase(client, config, submittedSells, {
    timeoutSeconds: sellPhaseTimeoutSeconds,
    pollSeconds,
    onPoll: (summary) => writeStatus({
      phase: 'sell_phase_waiting',
      target_file: targetFile,
      sell_phase: summary,
      target_invested_pct: config.stockTargetInvestedPct,
      order_submission: stockOrderMode(config),
      account,
    }),
  });

  if (!shouldProceedToBuyPhase(sellPhase)) {
    await writeStatus({
      phase: 'sell_phase_incomplete_buy_phase_skipped',
      target_file: targetFile,
      sell_phase: sellPhase,
      submitted_sell_orders: submittedSells.filter((row) => row.status === 'submitted').length,
      failed_sell_orders: submittedSells.filter((row) => row.status !== 'submitted').length,
      target_invested_pct: config.stockTargetInvestedPct,
      order_submission: stockOrderMode(config),
      account,
      orders_path: path.relative(PROJECT_ROOT, ordersPath),
    });
    return {
      sellPlan: executionPlan,
      buyPlan: null,
      submittedSells,
      submittedBuys: [],
      sellPhase,
      buyPhaseSkipped: true,
    };
  }

  await writeStatus({
    phase: 'buy_phase_planning',
    target_file: targetFile,
    sell_phase: sellPhase,
    target_invested_pct: config.stockTargetInvestedPct,
    order_submission: stockOrderMode(config),
    account,
  });
  const buyPlan = await createPlan({ client, quoteFeed, config, targets });
  buyPlan.target_file = targetFile;
  buyPlan.execution_phase = 'post_sell_buy_plan';
  buyPlan.prior_sell_phase = sellPhase;
  await writeLatestPlan(buyPlan);

  const { buyOrders } = splitRebalanceOrders(buyPlan.orders);
  await writeStatus({
    phase: 'buy_phase_submitting',
    target_file: targetFile,
    sell_phase: sellPhase,
    planned_buy_orders: buyOrders.length,
    target_invested_pct: config.stockTargetInvestedPct,
    order_submission: stockOrderMode(config),
    account,
  });
  const submittedBuys = await submitOrders(client, config, buyOrders, 'buy_phase');
  return {
    sellPlan: executionPlan,
    buyPlan,
    submittedSells,
    submittedBuys,
    sellPhase,
    buyPhaseSkipped: false,
  };
}

async function main() {
  const targetFile = args.targets || args.sheet || defaultTargetsPath;
  const { file, targets } = loadTargets(targetFile);
  const planOnly = isTruthyFlag(args['plan-only']);
  const execute = isTruthyFlag(args['execute-real']) && !planOnly;
  if (!planOnly && !execute) {
    throw new Error('Stock rebalance execution requires --execute-real. Use --plan-only to only generate the plan.');
  }
  const waitOpen = isTruthyFlag(args['wait-open']);
  const pollSeconds = Math.max(1, Number(args['poll-seconds'] || 5));
  const sellPhaseTimeoutSeconds = Math.max(1, Number(args['sell-phase-timeout-seconds'] || DEFAULT_SELL_PHASE_TIMEOUT_SECONDS));
  const config = normalizeStockOrderConfig(loadMoomooConfig({ envFile: args.env, ...stockOrderOverridesFromArgs() }));
  config.stockTargetInvestedPct = stockTargetInvestedPctFromArgs();
  assertRealAccountAllowed(config, execute);

  const connection = await connectMoomoo(config);
  const quoteFeed = createMoomooQuoteFeed(connection.client, config);
  try {
    const account = await ensureRealAccount(connection.client, config);
    await writeStatus({
      phase: 'planning',
      target_file: file,
      target_count: targets.length,
      execute,
      wait_open: waitOpen,
      sell_phase_timeout_seconds: sellPhaseTimeoutSeconds,
      target_invested_pct: config.stockTargetInvestedPct,
      order_submission: stockOrderMode(config),
      account,
    });
    const prePlan = await createPlan({ client: connection.client, quoteFeed, config, targets });
    prePlan.target_file = file;
    prePlan.execution_phase = 'pre_open_or_startup_plan';
    await writeLatestPlan(prePlan);

    if (planOnly) {
      await writeStatus({
        phase: 'planned',
        target_file: file,
        target_count: targets.length,
        execute: false,
        target_invested_pct: config.stockTargetInvestedPct,
        order_submission: stockOrderMode(config),
        account,
      });
      console.log(`Planned ${prePlan.orders.length} stock rebalance orders. Wrote ${latestPlanPath}`);
      return;
    }
    if (waitOpen) await waitForRegularOpen(pollSeconds);

    const executionPlan = await createPlan({ client: connection.client, quoteFeed, config, targets });
    executionPlan.target_file = file;
    executionPlan.execution_phase = 'open_sell_plan';
    await writeLatestPlan(executionPlan);
    const result = await executeSellThenBuy({
      client: connection.client,
      quoteFeed,
      config,
      targets,
      executionPlan,
      targetFile: file,
      account,
      pollSeconds,
      sellPhaseTimeoutSeconds,
    });
    const submitted = [...result.submittedSells, ...result.submittedBuys];
    const buyPlan = result.buyPlan || { orders: [] };
    const { sellOrders } = splitRebalanceOrders(executionPlan.orders);
    const { buyOrders } = splitRebalanceOrders(buyPlan.orders);
    await writeStatus({
      phase: result.buyPhaseSkipped ? 'complete_buy_phase_skipped' : 'complete',
      target_file: file,
      target_count: targets.length,
      planned_orders: executionPlan.orders.length,
      planned_sell_orders: sellOrders.length,
      planned_buy_orders: buyOrders.length,
      sell_phase: result.sellPhase,
      buy_phase_skipped: result.buyPhaseSkipped,
      submitted_orders: submitted.filter((row) => row.status === 'submitted').length,
      failed_orders: submitted.filter((row) => row.status !== 'submitted').length,
      target_invested_pct: config.stockTargetInvestedPct,
      order_submission: stockOrderMode(config),
      account,
      orders_path: path.relative(PROJECT_ROOT, ordersPath),
    });
    console.log(`Submitted ${submitted.filter((row) => row.status === 'submitted').length}/${submitted.length} stock rebalance orders. Buy phase ${result.buyPhaseSkipped ? 'skipped' : 'submitted'}.`);
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
