import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  PROJECT_ROOT,
  QOT_MARKET_US_SECURITY,
  TRD_ENV_SIMULATE,
  buildOptionExecutionQuote,
  connectMoomoo,
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
  placeLimitSellOrder,
  selectSimulatedUsOptionAccount,
} from './moomoo-opend.mjs';

const args = parseCliArgs();
const logsDir = path.join(PROJECT_ROOT, 'logs');
const executionsPath = path.join(logsDir, 'moomoo-executions.ndjson');
const exitOrdersPath = path.join(logsDir, 'moomoo-exit-orders.ndjson');
const statePath = path.join(logsDir, 'moomoo-exit-state.json');
const statusPath = path.join(logsDir, 'moomoo-exit-status.json');

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function simulationBuyPlans() {
  const seen = new Map();
  for (const plan of readNdjson(executionsPath)) {
    const orderIDEx = String(plan.execution?.response?.s2c?.orderIDEx || '');
    if (!orderIDEx) continue;
    if (plan.mode !== 'execute_simulate' || plan.order_status !== 'submitted') continue;
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

function nyParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const out = {};
  for (const part of parts) out[part.type] = part.value;
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

function isRegularSessionNow() {
  const p = nyParts();
  if (!isWeekday(p)) return false;
  const minutes = p.hour * 60 + p.minute;
  return minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
}

function isExitBeforeCloseNow() {
  const p = nyParts();
  if (!isWeekday(p)) return false;
  const minutes = p.hour * 60 + p.minute;
  return minutes >= 15 * 60 + 55 && minutes <= 16 * 60;
}

function exitTrigger(plan, underlyingPrice) {
  const rules = plan.order?.underlying_exit_rules || {};
  const direction = String(plan.signal?.direction || '').toLowerCase();
  const entry = numeric(rules.entry_price ?? plan.underlying_quote?.selected_entry_price ?? plan.signal?.stock_entry);
  const target = numeric(rules.signal_stock_target ?? plan.signal?.stock_target);
  const stop = numeric(rules.signal_stock_stop ?? plan.signal?.stock_stop);
  const stopMovePct = numeric(rules.stop_loss_move_pct) ?? 20;
  const takeMovePct = numeric(rules.take_profit_move_pct) ?? 50;
  const price = numeric(underlyingPrice);
  if (price === null || entry === null || !direction) return null;

  if (direction === 'bull') {
    if (target !== null && price >= target) return { reason: 'signal_stock_target', line: target, underlying_price: price };
    if (stop !== null && price <= stop) return { reason: 'signal_stock_stop', line: stop, underlying_price: price };
    if (price >= entry * (1 + takeMovePct / 100)) return { reason: 'underlying_50pct_take_profit', line: entry * (1 + takeMovePct / 100), underlying_price: price };
    if (price <= entry * (1 - stopMovePct / 100)) return { reason: 'underlying_20pct_stop_loss', line: entry * (1 - stopMovePct / 100), underlying_price: price };
  } else if (direction === 'bear') {
    if (target !== null && price <= target) return { reason: 'signal_stock_target', line: target, underlying_price: price };
    if (stop !== null && price >= stop) return { reason: 'signal_stock_stop', line: stop, underlying_price: price };
    if (price <= entry * (1 - takeMovePct / 100)) return { reason: 'underlying_50pct_take_profit', line: entry * (1 - takeMovePct / 100), underlying_price: price };
    if (price >= entry * (1 + stopMovePct / 100)) return { reason: 'underlying_20pct_stop_loss', line: entry * (1 + stopMovePct / 100), underlying_price: price };
  }

  if (rules.exit_before_regular_session_close && isExitBeforeCloseNow()) {
    return { reason: 'exit_before_regular_session_close', line: null, underlying_price: price };
  }
  return null;
}

function sellLimitPriceFromQuote(quoteModel) {
  if (Number.isFinite(quoteModel.sell_estimate_price) && quoteModel.sell_estimate_price > 0) return quoteModel.sell_estimate_price;
  if (Number.isFinite(quoteModel.bid) && quoteModel.bid > 0) return quoteModel.bid;
  return null;
}

function isTerminalUnfilledOrderStatus(status) {
  return [3, 15, 21, 22, 23].includes(Number(status));
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

async function processOnce(client, config, state) {
  const plans = simulationBuyPlans();
  const orderList = normalizeForJson((await fetchOrderList(client, config)).s2c?.orderList || []);
  const fillList = await safeOrderFillList(client, config);
  const positionList = normalizeForJson((await fetchPositionList(client, config)).s2c?.positionList || []);
  const ordersById = byOrderIDEx(orderList);
  const fillsById = fillSummaryByOrderIDEx(fillList);
  let submittedExits = 0;
  let watched = 0;

  for (const { orderIDEx, plan } of plans) {
    const stateRow = state.orders[orderIDEx] || {};
    if (stateRow.status === 'exit_submitted' || stateRow.status === 'closed') continue;

    const order = ordersById.get(orderIDEx);
    const fills = fillsById.get(orderIDEx);
    const filledQty = numeric(order?.fillQty) ?? numeric(fills?.buyQty) ?? 0;
    const fillAvgPrice = numeric(order?.fillAvgPrice)
      ?? (fills?.buyQty ? fills.buyValue / fills.buyQty : null);

    if (!filledQty || filledQty <= 0) {
      state.orders[orderIDEx] = {
        ...stateRow,
        status: isTerminalUnfilledOrderStatus(order?.orderStatus) ? 'buy_not_filled_terminal' : 'waiting_buy_fill',
        code: plan.order?.code,
        submitted_qty: plan.order?.qty,
        order_status: order?.orderStatus ?? null,
        updated_at: new Date().toISOString(),
      };
      continue;
    }

    const code = plan.order?.code;
    const position = positionList.find((item) => String(item.code || '') === String(code));
    const canSellQty = numeric(position?.canSellQty) ?? 0;
    const sellFilledQty = fills?.sellQty || 0;
    const remainingQty = Math.max(0, Math.floor(filledQty - sellFilledQty));
    const exitQty = Math.min(remainingQty, Math.floor(canSellQty));
    if (remainingQty <= 0) {
      state.orders[orderIDEx] = { ...stateRow, status: 'closed', code, updated_at: new Date().toISOString() };
      continue;
    }
    if (exitQty <= 0) {
      state.orders[orderIDEx] = {
        ...stateRow,
        status: 'waiting_sellable_qty',
        code,
        filled_qty: filledQty,
        remaining_qty: remainingQty,
        can_sell_qty: canSellQty,
        updated_at: new Date().toISOString(),
      };
      continue;
    }

    watched += 1;
    const optionSecurity = plan.contract?.security;
    const underlyingSecurity = { market: QOT_MARKET_US_SECURITY, code: plan.signal?.ticker };
    const snapshotResponse = await getSecuritySnapshots(client, [optionSecurity, underlyingSecurity]);
    const snapshots = snapshotResponse.s2c?.snapshotList || [];
    const optionSnapshot = snapshots.find((item) => item?.basic?.security?.code === optionSecurity.code) || null;
    const underlyingSnapshot = snapshots.find((item) => item?.basic?.security?.code === underlyingSecurity.code) || null;
    const underlyingPrice = numeric(underlyingSnapshot?.basic?.curPrice);
    const trigger = isRegularSessionNow() ? exitTrigger(plan, underlyingPrice) : null;

    state.orders[orderIDEx] = {
      ...stateRow,
      status: trigger ? 'exit_triggered' : 'monitoring',
      code,
      filled_qty: filledQty,
      fill_avg_price: fillAvgPrice,
      remaining_qty: remainingQty,
      can_sell_qty: canSellQty,
      underlying_price: underlyingPrice,
      last_trigger: trigger,
      updated_at: new Date().toISOString(),
    };
    if (!trigger) continue;

    const quoteModel = buildOptionExecutionQuote(optionSnapshot, config);
    const sellPrice = sellLimitPriceFromQuote(quoteModel);
    if (sellPrice === null) {
      state.orders[orderIDEx] = {
        ...state.orders[orderIDEx],
        status: 'exit_blocked_missing_bid',
        option_quote: quoteModel,
      };
      continue;
    }

    const remark = `exit:${String(plan.signal?.message_id || '').slice(-12)}`;
    const response = await placeLimitSellOrder(client, config, {
      code,
      qty: exitQty,
      price: sellPrice,
      remark,
      positionID: position?.positionID,
    });
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
      response: normalizeForJson(response),
    };
    await appendJsonLine(exitOrdersPath, exitPayload);
    state.orders[orderIDEx] = {
      ...state.orders[orderIDEx],
      status: 'exit_submitted',
      exit_order_id_ex: String(response.s2c?.orderIDEx || ''),
      exit_submitted_at: exitPayload.submitted_at,
      exit_price: sellPrice,
      exit_qty: exitQty,
      exit_trigger: trigger,
      updated_at: new Date().toISOString(),
    };
  }

  await writeState(state);
  await writeStatus({
    phase: 'ok',
    plans: plans.length,
    watched,
    submitted_exits: submittedExits,
  });
  return { plans: plans.length, watched, submittedExits };
}

async function main() {
  const config = loadMoomooConfig({ envFile: args.env });
  config.trdEnv = TRD_ENV_SIMULATE;
  const pollSeconds = Math.max(2, Number(args['poll-seconds'] || 10));
  const conn = await connectMoomoo(config);
  try {
    const simAccount = await ensureSimAccount(conn.client, config);
    await writeStatus({ phase: 'started', sim_account: simAccount, poll_seconds: pollSeconds });
    for (;;) {
      const state = loadState();
      const result = await processOnce(conn.client, config, state);
      console.log(`[${new Date().toISOString()}] plans=${result.plans} watched=${result.watched} submitted_exits=${result.submittedExits}`);
      if (!args.watch) break;
      await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
    }
  } finally {
    conn.close();
  }
}

main().catch(async (error) => {
  await writeStatus({ phase: 'error', error: error.message });
  console.error(error);
  process.exit(1);
});
