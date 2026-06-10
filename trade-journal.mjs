import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  PROJECT_ROOT,
  ensureDir,
  maskId,
  normalizeForJson,
} from './moomoo-opend.mjs';

export const tradeJournalPath = path.join(PROJECT_ROOT, 'logs', 'trade-journal.ndjson');
export const latestTradeJournalPath = path.join(PROJECT_ROOT, 'logs', 'trade-journal-latest.json');

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

function eventId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildTradeKey(plan, fallback = {}) {
  return [
    plan?.signal?.message_id || fallback.message_id || '',
    plan?.order?.code || fallback.code || '',
    fallback.orderIDEx || plan?.execution?.response?.s2c?.orderIDEx || '',
  ].filter(Boolean).join(':') || eventId();
}

export function buildStrategySnapshot(config) {
  return {
    policy_name: config.policy?.name || '',
    policy_version: config.policy?.version || null,
    decision_engine: config.policy?.execution?.decision_engine || 'local_deterministic_program',
    ai_decisioning_allowed: Boolean(config.policy?.execution?.ai_decisioning_allowed),
    required_advice_format: config.requiredAdviceFormat,
    min_win_rate: config.minWinRate,
    min_confidence: config.minConfidence,
    max_risk_score: config.maxRiskScore,
    paper_equity_usd: config.paperEquityUsd,
    target_position_pct: config.targetPositionPct,
    min_position_pct: config.minPositionPct,
    max_position_pct: config.maxPositionPct,
    option_take_profit_pct: config.optionTakeProfitPct,
    option_stop_loss_pct: config.optionStopLossPct,
    underlying_take_profit_pct: config.underlyingTakeProfitPct,
    underlying_stop_loss_pct: config.underlyingStopLossPct,
    execution_quality: {
      require_bid_ask: config.optionRequireBidAsk,
      min_bid_price: config.optionMinBidPrice,
      max_spread_pct_of_mid: config.optionMaxSpreadPctOfMid,
      max_spread_abs: config.optionMaxSpreadAbs,
      max_round_trip_loss_pct: config.optionMaxRoundTripLossPct,
      slippage_ticks: config.optionSlippageTicks,
      slippage_pct_of_spread: config.optionSlippagePctOfSpread,
      cap_qty_by_visible_ask: config.optionCapQtyByVisibleAsk,
      max_qty_to_ask_volume_ratio: config.optionMaxQtyToAskVolumeRatio,
      min_open_interest: config.optionMinOpenInterest,
      min_option_day_volume: config.optionMinDayVolume,
    },
    broker_env: {
      trd_env: config.trdEnv,
      trd_market: config.trdMarket,
      acc_id_masked: maskId(config.accId),
      env_file_loaded: Boolean(config.envLoaded),
    },
  };
}

export function buildRiskLines(plan, config = {}, opts = {}) {
  const signal = plan?.signal || {};
  const optionRules = plan?.order?.option_exit_rules || plan?.order?.underlying_exit_rules || {};
  const stockRules = plan?.order?.underlying_exit_rules || {};
  const optionEntry = numeric(opts.optionEntryPrice ?? plan?.order?.price);
  const signalTarget = numeric(stockRules.signal_stock_target ?? signal.stock_target);
  const signalStop = numeric(stockRules.signal_stock_stop ?? signal.stock_stop);
  const takePct = numeric(optionRules.take_profit_return_pct ?? optionRules.take_profit_move_pct ?? config.optionTakeProfitPct ?? config.underlyingTakeProfitPct) ?? 50;
  const stopPct = numeric(optionRules.stop_loss_return_pct ?? optionRules.stop_loss_move_pct ?? config.optionStopLossPct ?? config.underlyingStopLossPct) ?? 20;

  const pctTakeProfitLine = optionEntry === null ? null : optionEntry * (1 + takePct / 100);
  const pctStopLossLine = optionEntry === null ? null : optionEntry * (1 - stopPct / 100);

  return {
    price_basis: 'option_entry_fill_price',
    direction: String(signal.direction || '').toLowerCase(),
    option_entry_reference_price: optionEntry,
    take_profit_option_return_pct: takePct,
    stop_loss_option_return_pct: stopPct,
    percent_take_profit_option_line: pctTakeProfitLine === null ? null : Number(pctTakeProfitLine.toFixed(4)),
    percent_stop_loss_option_line: pctStopLossLine === null ? null : Number(pctStopLossLine.toFixed(4)),
    signal_stock_target_reference_only: signalTarget,
    signal_stock_stop_reference_only: signalStop,
    exit_before_regular_session_close: optionRules.exit_before_regular_session_close ?? true,
    no_overnight_holding: optionRules.no_overnight_holding ?? true,
  };
}

export function estimateOptionPnl({ entryPrice, exitPrice, qty, multiplier }) {
  const entry = numeric(entryPrice);
  const exit = numeric(exitPrice);
  const contracts = numeric(qty);
  const contractMultiplier = numeric(multiplier) ?? 100;
  if (entry === null || exit === null || contracts === null || contracts <= 0) {
    return null;
  }
  const entryValue = entry * contracts * contractMultiplier;
  const exitValue = exit * contracts * contractMultiplier;
  const gross = exitValue - entryValue;
  return {
    entry_option_price: entry,
    exit_option_price: exit,
    qty: contracts,
    contract_multiplier: contractMultiplier,
    entry_value_usd: roundMoney(entryValue),
    exit_value_usd: roundMoney(exitValue),
    gross_pnl_usd: roundMoney(gross),
    gross_return_pct: entryValue > 0 ? roundPct(gross / entryValue * 100) : null,
  };
}

export function buildPlanJournalPayload(plan, config, extra = {}) {
  const signal = plan.signal || {};
  const order = plan.order || null;
  return {
    source: 'moomoo-signal-trader',
    mode: plan.mode,
    lifecycle_status: plan.order_status,
    trade_key: buildTradeKey(plan, extra),
    signal,
    strategy: buildStrategySnapshot(config),
    gate: plan.gate,
    contract: plan.contract,
    entry_decision: {
      planned_at: plan.planned_at,
      order: order ? {
        side: order.side,
        order_type: order.order_type,
        code: order.code,
        qty: order.qty,
        price: order.price,
        price_basis: order.price_basis,
        remark: order.remark,
      } : null,
      risk_lines: buildRiskLines(plan, config),
      position_sizing: plan.position_sizing,
      option_quote: plan.quote?.execution_quality || null,
      option_snapshot_basic: plan.quote?.basic || null,
      option_ex_data: plan.quote?.option_ex_data || null,
      underlying_entry_quote: plan.underlying_quote || null,
    },
    broker: {
      simulated_account: plan.simulated_account || null,
      real_account: plan.real_account || null,
      order_request_redacted: order?.request || null,
      order_response: plan.execution?.response || null,
      error: plan.execution?.error || null,
    },
    notes_for_review: {
      focus: ['stop_loss', 'take_profit', 'position_sizing', 'spread_slippage', 'fill_quality'],
      data_use: 'local_review_or_ai_reference_only',
    },
  };
}

export function buildExitJournalPayload({
  plan,
  config,
  sourceBuyOrderIDEx,
  lifecycleStatus,
  brokerOrder,
  fills,
  position,
  filledQty,
  fillAvgPrice,
  remainingQty,
  canSellQty,
  optionQuote,
  optionSnapshotBasic,
  underlyingSnapshotBasic,
  underlyingPrice,
  quoteFeed,
  quoteSubscription,
  trigger,
  exitOrder,
  exitResponse,
  state,
  extra,
} = {}) {
  const contractMultiplier = numeric(plan?.position_sizing?.contract_multiplier)
    ?? numeric(plan?.position_sizing?.contract_multiplier_default)
    ?? 100;
  const currentExitPrice = numeric(exitOrder?.price ?? optionQuote?.sell_estimate_price ?? optionQuote?.bid);
  return {
    source: 'moomoo-exit-monitor',
    mode: plan?.mode || 'execute_simulate',
    lifecycle_status: lifecycleStatus,
    trade_key: buildTradeKey(plan, { orderIDEx: sourceBuyOrderIDEx }),
    source_buy_order_id_ex: sourceBuyOrderIDEx || '',
    signal: plan?.signal || null,
    strategy: buildStrategySnapshot(config),
    risk_lines: buildRiskLines(plan, config, { optionEntryPrice: fillAvgPrice }),
    contract: plan?.contract || null,
    entry: {
      order: plan?.order || null,
      submitted_at: plan?.execution?.submitted_at || '',
      buy_order_response: plan?.execution?.response || null,
      fill_qty: filledQty ?? null,
      fill_avg_price: fillAvgPrice ?? null,
    },
    current_position: {
      remaining_qty: remainingQty ?? null,
      can_sell_qty: canSellQty ?? null,
      position: position || null,
      broker_order: brokerOrder || null,
      fills: fills || null,
      state: state || null,
    },
    market_snapshot: {
      captured_at: new Date().toISOString(),
      underlying_price: underlyingPrice ?? null,
      underlying_snapshot_basic: underlyingSnapshotBasic || null,
      option_quote: optionQuote || null,
      option_snapshot_basic: optionSnapshotBasic || null,
      quote_feed: quoteFeed || null,
      quote_subscription: quoteSubscription || null,
    },
    exit_decision: {
      trigger: trigger || null,
      exit_order: exitOrder || null,
      exit_response: exitResponse || null,
      estimated_pnl: estimateOptionPnl({
        entryPrice: fillAvgPrice,
        exitPrice: currentExitPrice,
        qty: exitOrder?.qty ?? remainingQty,
        multiplier: contractMultiplier,
      }),
    },
    notes_for_review: {
      focus: ['stop_loss', 'take_profit', 'position_sizing', 'spread_slippage', 'fill_quality'],
      data_use: 'local_review_or_ai_reference_only',
    },
    ...(extra || {}),
  };
}

export async function appendTradeJournalEvent(eventType, payload = {}) {
  const event = normalizeForJson({
    schema_version: 1,
    event_id: eventId(),
    event_type: eventType,
    recorded_at: new Date().toISOString(),
    ...payload,
  });
  await ensureDir(path.dirname(tradeJournalPath));
  await fsp.appendFile(tradeJournalPath, `${JSON.stringify(event)}\n`, 'utf8');
  await fsp.writeFile(latestTradeJournalPath, `${JSON.stringify(event, null, 2)}\n`, 'utf8');
  return event;
}
