import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
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

function sellLimitPriceFromQuote(quoteModel) {
  if (Number.isFinite(quoteModel.sell_estimate_price) && quoteModel.sell_estimate_price > 0) return quoteModel.sell_estimate_price;
  if (Number.isFinite(quoteModel.bid) && quoteModel.bid > 0) return quoteModel.bid;
  return null;
}

function optionReturnPct(entryPrice, exitPrice) {
  const entry = numeric(entryPrice);
  const exit = numeric(exitPrice);
  if (entry === null || entry <= 0 || exit === null) return null;
  return Number(((exit - entry) / entry * 100).toFixed(4));
}

function exitRules(plan) {
  return plan.order?.option_exit_rules || plan.order?.underlying_exit_rules || {};
}

function exitTrigger(plan, config, { optionEntryPrice, optionExitPrice, underlyingPrice } = {}) {
  const rules = exitRules(plan);
  const entry = numeric(optionEntryPrice);
  const exit = numeric(optionExitPrice);
  const stopPct = numeric(rules.stop_loss_return_pct ?? rules.stop_loss_move_pct ?? config.optionStopLossPct ?? config.underlyingStopLossPct) ?? 20;
  const takePct = numeric(rules.take_profit_return_pct ?? rules.take_profit_move_pct ?? config.optionTakeProfitPct ?? config.underlyingTakeProfitPct) ?? 50;

  if (entry !== null && entry > 0 && exit !== null) {
    const takeLine = entry * (1 + takePct / 100);
    const stopLine = entry * (1 - stopPct / 100);
    const returnPct = optionReturnPct(entry, exit);
    if (exit >= takeLine) {
      return {
        reason: 'option_50pct_take_profit',
        line: Number(takeLine.toFixed(4)),
        option_entry_price: entry,
        option_exit_price: exit,
        option_return_pct: returnPct,
        underlying_price: numeric(underlyingPrice),
      };
    }
    if (exit <= stopLine) {
      return {
        reason: 'option_20pct_stop_loss',
        line: Number(stopLine.toFixed(4)),
        option_entry_price: entry,
        option_exit_price: exit,
        option_return_pct: returnPct,
        underlying_price: numeric(underlyingPrice),
      };
    }
  }

  if (rules.exit_before_regular_session_close !== false && isExitBeforeCloseNow()) {
    return {
      reason: 'exit_before_regular_session_close',
      line: null,
      option_entry_price: entry,
      option_exit_price: exit,
      option_return_pct: optionReturnPct(entry, exit),
      underlying_price: numeric(underlyingPrice),
    };
  }
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

function getMode(config) {
  if (args['execute-real']) {
    if (!config.allowRealTrading) {
      throw new Error('Real exit monitoring is blocked. Set MOOMOO_ALLOW_REAL_TRADING=true and pass --execute-real only after confirming account and risk controls.');
    }
    if (String(process.env.MOOMOO_REAL_TRADING_CONFIRM || '') !== 'I_UNDERSTAND') {
      throw new Error('Real exit monitoring is blocked. Set MOOMOO_REAL_TRADING_CONFIRM=I_UNDERSTAND to remove the last real-trading guard.');
    }
    config.trdEnv = TRD_ENV_REAL;
    return 'execute_real';
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

  for (const { orderIDEx, plan } of plans) {
    const stateRow = state.orders[orderIDEx] || {};
    if (stateRow.status === 'closed') continue;

    const order = ordersById.get(orderIDEx);
    const fills = fillsById.get(orderIDEx);
    const filledQty = numeric(order?.fillQty) ?? numeric(fills?.buyQty) ?? 0;
    const fillAvgPrice = numeric(order?.fillAvgPrice)
      ?? (fills?.buyQty ? fills.buyValue / fills.buyQty : null);

    if (stateRow.status === 'exit_submitted' || stateRow.status === 'exit_waiting_fill') {
      const exitOrder = ordersById.get(String(stateRow.exit_order_id_ex || ''));
      const exitFilledQty = numeric(exitOrder?.fillQty) ?? 0;
      const exitFillAvgPrice = numeric(exitOrder?.fillAvgPrice) ?? numeric(stateRow.exit_price);
      const code = plan.order?.code;
      const position = positionList.find((item) => String(item.code || '') === String(code));
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

      const fullyExited = (expectedExitQty > 0 && exitFilledQty >= expectedExitQty)
        || (position && canSellQty <= 0);
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

    const code = plan.order?.code;
    const position = positionList.find((item) => String(item.code || '') === String(code));
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
    const underlyingPrice = numeric(underlyingSnapshot?.basic?.curPrice);
    const quoteModel = buildOptionExecutionQuote(optionSnapshot, config);
    const optionExitPrice = sellLimitPriceFromQuote(quoteModel);
    const trigger = isRegularSessionNow()
      ? exitTrigger(plan, config, {
        optionEntryPrice: fillAvgPrice,
        optionExitPrice,
        underlyingPrice,
      })
      : null;

    nextState = {
      ...nextState,
      status: trigger ? 'exit_triggered' : 'monitoring',
      underlying_price: underlyingPrice,
      underlying_quote_error: underlyingQuoteError,
      option_entry_price: fillAvgPrice,
      option_exit_price: optionExitPrice,
      option_return_pct: optionReturnPct(fillAvgPrice, optionExitPrice),
      last_trigger: trigger,
      updated_at: new Date().toISOString(),
    };
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
        trigger,
        state: nextState,
      }),
    );
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

    const sellPrice = sellLimitPriceFromQuote(quoteModel);
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
  const pollSeconds = Math.max(1, Number(args['poll-seconds'] || 2));
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
      const result = await processOnce(conn.client, config, state, quoteFeed, mode);
      console.log(`[${new Date().toISOString()}] mode=${mode} plans=${result.plans} watched=${result.watched} submitted_exits=${result.submittedExits} pushes=${quoteFeed.status().push_count}`);
      if (!args.watch) break;
      await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
    }
  } finally {
    await quoteFeed.close();
    conn.close();
  }
}

main().catch(async (error) => {
  await writeStatus({ phase: 'error', error: error.message });
  console.error(error);
  process.exit(1);
});
