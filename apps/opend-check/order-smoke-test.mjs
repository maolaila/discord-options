import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_ROOT,
  QOT_MARKET_US_SECURITY,
  TRD_ENV_REAL,
  cancelOrder,
  connectMoomoo,
  createMoomooQuoteFeed,
  ensureDir,
  fetchMoomooAccounts,
  fetchOrderList,
  fetchPositionList,
  isProtectedStockSymbol,
  loadMoomooConfig,
  maskId,
  normalizeForJson,
  parseCliArgs,
  placeLimitBuyOrder,
  placeLimitSellOrder,
  selectConfiguredUsRealAccount,
} from '../../packages/moomoo-opend/moomoo-opend.mjs';

const args = parseCliArgs();
const logsDir = path.join(PROJECT_ROOT, 'logs');
const latestPath = path.join(logsDir, 'order-smoke-test-latest.json');
const eventsPath = path.join(logsDir, 'order-smoke-test.ndjson');

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

function stockSecurity(symbol) {
  return { market: QOT_MARKET_US_SECURITY, code: normalizeSymbol(symbol) };
}

function roundDownCents(value) {
  return Number((Math.floor(Number(value) * 100) / 100).toFixed(2));
}

function quotePrice(snapshot) {
  const basic = snapshot?.basic || {};
  return numeric(basic.curPrice) ?? numeric(basic.lastClosePrice) ?? numeric(basic.openPrice);
}

function newYorkParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const out = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: out.weekday,
    hour: Number(out.hour === '24' ? '0' : out.hour),
    minute: Number(out.minute),
  };
}

function isRegularSessionNow(date = new Date()) {
  const parts = newYorkParts(date);
  const minutes = parts.hour * 60 + parts.minute;
  return !['Sat', 'Sun'].includes(parts.weekday) && minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
}

async function writeLatest(payload) {
  await ensureDir(path.dirname(latestPath));
  await fsp.writeFile(latestPath, `${JSON.stringify({ updated_at: new Date().toISOString(), ...payload }, null, 2)}\n`, 'utf8');
}

async function appendEvent(payload) {
  await ensureDir(path.dirname(eventsPath));
  await fsp.appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`, 'utf8');
}

function assertRealSmokeAllowed(config) {
  config.trdEnv = TRD_ENV_REAL;
  if (!isTruthyFlag(args['execute-real'])) {
    throw new Error('Smoke order requires --execute-real.');
  }
  if (!config.allowRealTrading) {
    throw new Error('Smoke order is blocked. Set MOOMOO_ALLOW_REAL_TRADING=true for this process.');
  }
  if (String(process.env.MOOMOO_REAL_TRADING_CONFIRM || '') !== 'I_UNDERSTAND') {
    throw new Error('Smoke order is blocked. Set MOOMOO_REAL_TRADING_CONFIRM=I_UNDERSTAND for this process.');
  }
  if (String(process.env.MOOMOO_ORDER_SMOKE_CONFIRM || '') !== 'I_UNDERSTAND') {
    throw new Error('Smoke order is blocked. Set MOOMOO_ORDER_SMOKE_CONFIRM=I_UNDERSTAND for this process.');
  }
  if (isRegularSessionNow() && !isTruthyFlag(args['allow-regular-session'])) {
    throw new Error('Smoke order refuses to run during the US regular session unless --allow-regular-session is passed.');
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

function findOrder(orderList, orderIDEx) {
  const id = String(orderIDEx || '');
  return (orderList || []).find((order) => String(order.orderIDEx || '') === id) || null;
}

async function fetchOrder(client, config, orderIDEx) {
  const orderList = normalizeForJson((await fetchOrderList(client, config)).s2c?.orderList || []);
  return findOrder(orderList, orderIDEx);
}

async function pollOrder(client, config, orderIDEx, predicate, timeoutMs = 15000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start <= timeoutMs) {
    last = await fetchOrder(client, config, orderIDEx);
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return last;
}

function orderStatusName(status) {
  const names = {
    5: 'submitted',
    10: 'filled_part',
    11: 'filled_all',
    12: 'cancelling_part',
    13: 'cancelling_all',
    14: 'cancelled_part',
    15: 'cancelled_all',
    21: 'failed',
    22: 'disabled',
    23: 'deleted',
  };
  return names[Number(status)] || String(status ?? 'unknown');
}

function redactBrokerPayload(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactBrokerPayload(item));
  if (typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === 'accID' ? maskId(item) : redactBrokerPayload(item),
    ]),
  );
}

function normalizeStockPositions(positionList) {
  const out = [];
  for (const raw of positionList || []) {
    const symbol = normalizeSymbol(raw?.code);
    const qty = Math.floor(numeric(raw?.qty) ?? 0);
    const canSellQty = Math.floor(numeric(raw?.canSellQty) ?? qty);
    if (!isStockSymbol(symbol) || qty <= 0) continue;
    out.push({
      symbol,
      qty,
      can_sell_qty: canSellQty,
      price: numeric(raw.price),
      position_id: raw.positionID,
      raw: normalizeForJson(raw),
    });
  }
  return out;
}

async function getSellProbePosition(client, config, symbol, qty) {
  const response = await fetchPositionList(client, config);
  const positions = normalizeStockPositions(normalizeForJson(response).s2c?.positionList || []);
  const match = positions.find((position) => position.symbol === symbol) || null;
  if (!match) {
    throw new Error(`No real stock position found for SELL smoke symbol ${symbol}.`);
  }
  if (Math.floor(match.can_sell_qty) < qty) {
    throw new Error(`SELL smoke symbol ${symbol} has can_sell_qty=${match.can_sell_qty}, below qty=${qty}.`);
  }
  return match;
}

async function main() {
  const symbol = normalizeSymbol(args.symbol || process.env.MOOMOO_ORDER_SMOKE_SYMBOL || 'AAPL');
  const qty = Math.max(1, Math.floor(Number(args.qty || process.env.MOOMOO_ORDER_SMOKE_QTY || 1)));
  const maxNotional = Math.max(1, Number(args['max-notional'] || process.env.MOOMOO_ORDER_SMOKE_MAX_NOTIONAL || 100));
  const side = String(args.side || process.env.MOOMOO_ORDER_SMOKE_SIDE || 'BUY').trim().toUpperCase();
  if (!['BUY', 'SELL'].includes(side)) throw new Error('Smoke order --side must be BUY or SELL.');
  const defaultRatio = side === 'SELL' ? 1.5 : 0.35;
  const priceRatio = Number(args['price-ratio'] || process.env.MOOMOO_ORDER_SMOKE_PRICE_RATIO || defaultRatio);
  if (side === 'BUY' && (priceRatio <= 0 || priceRatio >= 1)) throw new Error('BUY smoke price ratio must be > 0 and < 1.');
  if (side === 'SELL' && priceRatio <= 1) throw new Error('SELL smoke price ratio must be > 1.');
  if (!/^[A-Z][A-Z0-9.-]{0,12}$/.test(symbol)) throw new Error(`Invalid smoke order symbol: ${symbol}`);

  const config = loadMoomooConfig({ envFile: args.env });
  if (isProtectedStockSymbol(symbol, config.protectedStockSymbols)) {
    throw new Error(`Smoke order refuses to touch protected stock symbol ${symbol}.`);
  }
  assertRealSmokeAllowed(config);

  const connection = await connectMoomoo(config);
  const quoteFeed = createMoomooQuoteFeed(connection.client, config);
  let placedOrderIDEx = '';
  try {
    const account = await ensureRealAccount(connection.client, config);
    const quoteResult = await quoteFeed.getSnapshots([stockSecurity(symbol)], {
      orderBookSecurities: [],
    });
    const snapshot = quoteResult.snapshots?.[0] || null;
    const referencePrice = quotePrice(snapshot);
    if (referencePrice === null || referencePrice <= 0) throw new Error(`No usable quote price for ${symbol}.`);
    const sellProbePosition = side === 'SELL'
      ? await getSellProbePosition(connection.client, config, symbol, qty)
      : null;
    const cappedPrice = side === 'SELL'
      ? referencePrice * priceRatio
      : Math.min(referencePrice * priceRatio, maxNotional / qty);
    const limitPrice = roundDownCents(cappedPrice);
    if (limitPrice <= 0) throw new Error(`Computed invalid smoke limit price: ${limitPrice}`);

    const order = {
      side,
      code: symbol,
      qty,
      price: limitPrice,
      remark: 'SMOKE_CANCEL_TEST',
    };
    if (sellProbePosition?.position_id !== undefined) {
      order.positionID = sellProbePosition.position_id;
    }
    await writeLatest({
      phase: 'placing',
      account,
      order,
      reference_price: referencePrice,
      sell_probe_position: sellProbePosition ? {
        symbol: sellProbePosition.symbol,
        qty: sellProbePosition.qty,
        can_sell_qty: sellProbePosition.can_sell_qty,
        position_id: sellProbePosition.position_id,
      } : null,
      max_notional: maxNotional,
      regular_session_now: isRegularSessionNow(),
    });
    await appendEvent({ phase: 'placing', order, reference_price: referencePrice, account });

    const placeResponse = side === 'SELL'
      ? await placeLimitSellOrder(connection.client, config, order)
      : await placeLimitBuyOrder(connection.client, config, order);
    placedOrderIDEx = String(placeResponse.s2c?.orderIDEx || '');
    const placedOrderID = placeResponse.s2c?.orderID;
    await appendEvent({ phase: 'placed', order_id_ex: placedOrderIDEx, response: redactBrokerPayload(normalizeForJson(placeResponse)) });

    const submittedOrder = await pollOrder(
      connection.client,
      config,
      placedOrderIDEx,
      (row) => row.orderStatus !== undefined,
      10000,
    );
    const fillQty = numeric(submittedOrder?.fillQty) ?? 0;
    if (fillQty > 0) {
      throw new Error(`Smoke order unexpectedly filled before cancel. orderIDEx=${placedOrderIDEx} fillQty=${fillQty}`);
    }

    const cancelResponse = await cancelOrder(connection.client, config, {
      orderID: placedOrderID || 0,
      orderIDEx: placedOrderIDEx,
    });
    await appendEvent({ phase: 'cancel_submitted', order_id_ex: placedOrderIDEx, response: redactBrokerPayload(normalizeForJson(cancelResponse)) });

    const finalOrder = await pollOrder(
      connection.client,
      config,
      placedOrderIDEx,
      (row) => [14, 15, 21, 22, 23].includes(Number(row.orderStatus)) || Number(row.fillQty || 0) > 0,
      20000,
    );
    const finalFillQty = numeric(finalOrder?.fillQty) ?? 0;
    const finalStatus = finalOrder?.orderStatus ?? null;
    const result = {
      phase: [14, 15].includes(Number(finalStatus)) && finalFillQty <= 0 ? 'cancelled' : 'needs_manual_review',
      account,
      order,
      order_id_ex: placedOrderIDEx,
      reference_price: referencePrice,
      placed_response: redactBrokerPayload(normalizeForJson(placeResponse)),
      cancel_response: redactBrokerPayload(normalizeForJson(cancelResponse)),
      final_order: normalizeForJson(finalOrder),
      final_order_status: finalStatus,
      final_order_status_name: orderStatusName(finalStatus),
      final_fill_qty: finalFillQty,
      events_path: path.relative(PROJECT_ROOT, eventsPath),
    };
    await writeLatest(result);
    await appendEvent(result);
    console.log(JSON.stringify(result, null, 2));
    if (result.phase !== 'cancelled') process.exitCode = 2;
  } catch (error) {
    if (placedOrderIDEx) {
      try {
        await cancelOrder(connection.client, config, { orderIDEx: placedOrderIDEx });
        await appendEvent({ phase: 'emergency_cancel_submitted', order_id_ex: placedOrderIDEx });
      } catch (cancelError) {
        await appendEvent({ phase: 'emergency_cancel_failed', order_id_ex: placedOrderIDEx, error: cancelError.message });
      }
    }
    await writeLatest({ phase: 'error', order_id_ex: placedOrderIDEx, error: error.message });
    console.error(error);
    process.exitCode = 1;
  } finally {
    await quoteFeed.close();
    connection.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeLatest({ phase: 'error', error: error.message });
    console.error(error);
    process.exit(1);
  });
}
