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
  fetchFunds,
  fetchMoomooAccounts,
  fetchPositionList,
  loadMoomooConfig,
  maskId,
  normalizeForJson,
  parseCliArgs,
  placeMarketBuyOrder,
  placeMarketSellOrder,
  selectConfiguredUsRealAccount,
} from './moomoo-opend.mjs';

const args = parseCliArgs();
const logsDir = path.join(PROJECT_ROOT, 'logs');
export const defaultTargetsPath = path.join(PROJECT_ROOT, 'stock-rebalance-targets.csv');
const statusPath = path.join(logsDir, 'stock-rebalance-status.json');
const latestPlanPath = path.join(logsDir, 'stock-rebalance-plan-latest.json');
const ordersPath = path.join(logsDir, 'stock-rebalance-orders.ndjson');

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function positionValue(position, price) {
  const value = numeric(position.market_value);
  if (value !== null && value >= 0) return value;
  const px = numeric(price) ?? numeric(position.price);
  return px === null ? 0 : position.qty * px;
}

function quoteForSymbol(quoteMap, symbol) {
  return quoteMap.get(normalizeSymbol(symbol)) || {};
}

export function buildRebalancePlan({ targets, positions, funds, quotes, generatedAt = new Date().toISOString() }) {
  const targetSymbols = new Set(targets.map((row) => row.symbol));
  const quoteMap = quotes instanceof Map ? quotes : new Map(Object.entries(quotes || {}));
  const currentBySymbol = new Map();
  for (const position of positions) currentBySymbol.set(position.symbol, position);

  const cash = fundsCash(funds);
  const stockValue = positions.reduce((sum, position) => {
    const quote = quoteForSymbol(quoteMap, position.symbol);
    return sum + positionValue(position, quote.price);
  }, 0);
  const portfolioValue = cash + stockValue;
  const targetRows = targets.map((target) => {
    const current = currentBySymbol.get(target.symbol) || { symbol: target.symbol, qty: 0, can_sell_qty: 0 };
    const quote = quoteForSymbol(quoteMap, target.symbol);
    const price = numeric(quote.price) ?? numeric(current.price);
    const targetValue = portfolioValue * target.target_pct / 100;
    const desiredQty = price && price > 0 ? Math.floor(targetValue / price) : 0;
    const deltaQty = desiredQty - Math.floor(current.qty || 0);
    return {
      symbol: target.symbol,
      target_pct: target.target_pct,
      target_value: Number(targetValue.toFixed(2)),
      price,
      current_qty: Math.floor(current.qty || 0),
      desired_qty: desiredQty,
      delta_qty: deltaQty,
      current_value: Number(positionValue(current, price).toFixed(2)),
      position_id: current.position_id,
      can_sell_qty: Math.floor(current.can_sell_qty || 0),
    };
  });

  const orders = [];
  for (const position of positions) {
    if (!targetSymbols.has(position.symbol)) {
      const qty = Math.min(Math.floor(position.qty), Math.floor(position.can_sell_qty));
      if (qty > 0) {
        orders.push({
          side: 'SELL',
          symbol: position.symbol,
          qty,
          order_type: 'MARKET',
          reason: 'not_in_target_sheet',
          position_id: position.position_id,
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
          order_type: 'MARKET',
          reason: 'rebalance_overweight',
          position_id: row.position_id,
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
        order_type: 'MARKET',
        reason: 'rebalance_underweight',
      });
    }
  }

  return {
    generated_at: generatedAt,
    mode: 'stock_rebalance_live',
    cash: Number(cash.toFixed(2)),
    stock_value: Number(stockValue.toFixed(2)),
    portfolio_value: Number(portfolioValue.toFixed(2)),
    target_count: targets.length,
    targets: targetRows,
    off_sheet_positions: positions
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
  const result = await quoteFeed.getSnapshots(securities, {
    orderBookSecurities: [],
    warmupMs: config.quotePushWarmupMs,
  });
  const out = new Map();
  for (const snapshot of result.snapshots || []) {
    const symbol = normalizeSymbol(snapshot?.basic?.security?.code);
    if (!symbol) continue;
    out.set(symbol, {
      price: quotePrice(snapshot),
      basic: normalizeForJson(snapshot?.basic || null),
      quote_source: snapshot?.quote_source || null,
      quote_received_at: snapshot?.quote_received_at || null,
    });
  }
  return out;
}

async function createPlan({ client, quoteFeed, config, targets }) {
  const positionsResponse = await fetchPositionList(client, config);
  const fundsResponse = await fetchFunds(client, config);
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
  });
  plan.account = { accID: maskId(config.accId), trdEnv: config.trdEnv };
  return plan;
}

async function executePlan(client, config, plan) {
  const submitted = [];
  for (const order of plan.orders) {
    const payload = {
      submitted_at: new Date().toISOString(),
      business_line: 'stock_rebalance_live',
      side: order.side,
      symbol: order.symbol,
      qty: order.qty,
      order_type: order.order_type,
      reason: order.reason,
    };
    try {
      const request = {
        code: order.symbol,
        qty: order.qty,
        remark: `rebalance:${order.reason}`.slice(0, 60),
        positionID: order.position_id,
      };
      const response = order.side === 'BUY'
        ? await placeMarketBuyOrder(client, config, request)
        : await placeMarketSellOrder(client, config, request);
      payload.status = 'submitted';
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
  const config = loadMoomooConfig({ envFile: args.env });
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
      account,
    });
    const prePlan = await createPlan({ client: connection.client, quoteFeed, config, targets });
    prePlan.target_file = file;
    prePlan.execution_phase = 'pre_open_or_startup_plan';
    await writeLatestPlan(prePlan);

    if (planOnly) {
      await writeStatus({ phase: 'planned', target_file: file, target_count: targets.length, execute: false, account });
      console.log(`Planned ${prePlan.orders.length} stock rebalance orders. Wrote ${latestPlanPath}`);
      return;
    }
    if (waitOpen) await waitForRegularOpen(pollSeconds);

    const executionPlan = await createPlan({ client: connection.client, quoteFeed, config, targets });
    executionPlan.target_file = file;
    executionPlan.execution_phase = 'execution_plan';
    await writeLatestPlan(executionPlan);
    const submitted = await executePlan(connection.client, config, executionPlan);
    await writeStatus({
      phase: 'complete',
      target_file: file,
      target_count: targets.length,
      planned_orders: executionPlan.orders.length,
      submitted_orders: submitted.filter((row) => row.status === 'submitted').length,
      failed_orders: submitted.filter((row) => row.status !== 'submitted').length,
      account,
      orders_path: path.relative(PROJECT_ROOT, ordersPath),
    });
    console.log(`Submitted ${submitted.filter((row) => row.status === 'submitted').length}/${submitted.length} stock rebalance orders.`);
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
