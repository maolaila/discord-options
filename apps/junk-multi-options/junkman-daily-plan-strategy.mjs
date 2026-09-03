import { createHash } from 'node:crypto';

export const JUNKMAN_DAILY_PLAN_STRATEGY = 'junkman_discord_daily_plan_v1';

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestBar(marketContext) {
  const bars = Array.isArray(marketContext?.bars_5m) ? marketContext.bars_5m : [];
  return bars.at(-1) || null;
}

function noTrade(plan, marketContext, reasonCodes, nowMs) {
  return {
    generated_at: new Date(nowMs).toISOString(),
    strategy: JUNKMAN_DAILY_PLAN_STRATEGY,
    ticker: plan?.ticker || null,
    decision: 'no_trade',
    action: 'hold',
    reason_codes: [...new Set(reasonCodes)],
    source_daily_plan: plan || null,
    market_context: marketContext || null,
  };
}

function scenarioWeight(plan, direction) {
  const kind = plan?.execution?.kind === 'magnet_mean_reversion'
    ? 'range'
    : direction === 'bull' ? 'bull' : 'bear';
  return finiteNumber(plan?.scenarios?.find((row) => row.kind === kind)?.weight_pct) ?? 0;
}

export function selectPlannedOptionStrike({ direction, current_price_usd, strikes_by_right } = {}) {
  const current = finiteNumber(current_price_usd);
  if (current === null) return null;
  const right = direction === 'bull' ? 'C' : direction === 'bear' ? 'P' : null;
  if (!right) return null;
  const strikes = [...new Set((strikes_by_right?.[right] || []).map(finiteNumber).filter((value) => value !== null && value > 0))]
    .sort((left, rightValue) => left - rightValue);
  if (direction === 'bull') return strikes.find((value) => value > current) ?? null;
  return strikes.filter((value) => value < current).at(-1) ?? null;
}

function plannedTrigger(plan, bar) {
  const execution = plan.execution;
  const open = finiteNumber(bar.open_usd);
  const high = finiteNumber(bar.high_usd);
  const low = finiteNumber(bar.low_usd);
  const close = finiteNumber(bar.close_usd);
  if ([open, high, low, close].some((value) => value === null)) return null;

  if (execution.kind === 'magnet_mean_reversion') {
    const lower = finiteNumber(execution.trigger_zone?.lower_usd);
    const upper = finiteNumber(execution.trigger_zone?.upper_usd);
    const center = finiteNumber(execution.long?.target_usd);
    if ([lower, upper, center].some((value) => value === null)) return null;
    const crossedWholeZone = low <= lower && high >= upper;
    if (!crossedWholeZone && low <= lower && close > lower && close < center && close > open) {
      return { direction: 'bull', leg: execution.long, node_reaction: 'rejection_retest' };
    }
    if (!crossedWholeZone && high >= upper && close < upper && close > center && close < open) {
      return { direction: 'bear', leg: execution.bear, node_reaction: 'rejection_retest' };
    }
    return null;
  }

  if (execution.kind === 'bullish_retest') {
    const lower = finiteNumber(execution.trigger_zone?.lower_usd);
    const upper = finiteNumber(execution.trigger_zone?.upper_usd);
    const touched = low <= upper && high >= lower;
    return touched && close > upper && close > open
      ? { direction: 'bull', leg: execution.long, node_reaction: 'support_retest' }
      : null;
  }

  if (execution.kind === 'bearish_retest') {
    const lower = finiteNumber(execution.trigger_zone?.lower_usd);
    const upper = finiteNumber(execution.trigger_zone?.upper_usd);
    const touched = high >= lower && low <= upper;
    return touched && close < lower && close < open
      ? { direction: 'bear', leg: execution.bear, node_reaction: 'resistance_retest' }
      : null;
  }

  if (execution.kind === 'flip_direction_confirmation') {
    const lower = finiteNumber(execution.trigger_zone?.lower_usd);
    const upper = finiteNumber(execution.trigger_zone?.upper_usd);
    if (low <= upper && close > upper && close > open) {
      return { direction: 'bull', leg: execution.long, node_reaction: 'breakout_retest' };
    }
    if (high >= lower && close < lower && close < open) {
      return { direction: 'bear', leg: execution.bear, node_reaction: 'breakdown_retest' };
    }
  }
  return null;
}

export function evaluateJunkmanDailyPlan({
  plan,
  market_context,
  strikes_by_right,
  expiration,
  now_ms = Date.now(),
} = {}) {
  const reasons = [];
  if (!plan?.actionable || !plan?.execution) reasons.push('daily_plan_not_actionable');
  if (plan?.session_date_et !== expiration) reasons.push('daily_plan_session_mismatch');
  if (!market_context?.price_action_ready) reasons.push('closed_five_minute_bar_missing');
  const bar = latestBar(market_context);
  if (!bar) reasons.push('closed_five_minute_bar_missing');
  if (reasons.length) return noTrade(plan, market_context, reasons, now_ms);

  const trigger = plannedTrigger(plan, bar);
  if (!trigger) return noTrade(plan, market_context, ['daily_plan_trigger_not_confirmed'], now_ms);
  const current = finiteNumber(bar.close_usd);
  const invalidation = finiteNumber(trigger.leg?.invalidation_usd);
  const target = finiteNumber(trigger.leg?.target_usd);
  if (trigger.direction === 'bull' && !(invalidation < current && current < target)) {
    return noTrade(plan, market_context, ['daily_plan_bull_price_outside_invalidation_target'], now_ms);
  }
  if (trigger.direction === 'bear' && !(target < current && current < invalidation)) {
    return noTrade(plan, market_context, ['daily_plan_bear_price_outside_target_invalidation'], now_ms);
  }
  const strike = selectPlannedOptionStrike({
    direction: trigger.direction,
    current_price_usd: current,
    strikes_by_right,
  });
  if (strike === null) return noTrade(plan, market_context, ['daily_plan_option_strike_unavailable'], now_ms);

  const signalId = `junkman_daily_${createHash('sha256').update([
    plan.event_id,
    bar.timestamp,
    trigger.direction,
    strike,
  ].join('|')).digest('hex').slice(0, 20)}`;
  return {
    generated_at: new Date(now_ms).toISOString(),
    snapshot_at: bar.timestamp,
    signal_id: signalId,
    strategy: JUNKMAN_DAILY_PLAN_STRATEGY,
    ticker: plan.ticker,
    expiration,
    decision: 'trade',
    action: 'open_long_option',
    direction: trigger.direction,
    option_type: trigger.direction === 'bull' ? 'C' : 'P',
    strike,
    entry_confirmed: true,
    price_action_confirmed: true,
    node_reaction: trigger.node_reaction,
    trigger_price: current,
    invalidation_price: invalidation,
    invalidation_basis: 'discord_daily_plan_explicit_invalidation',
    target_price: target,
    gex_state: 'daily_plan_current_session',
    option_selection: {
      expiry_days: 0,
      option_right: trigger.direction === 'bull' ? 'C' : 'P',
      strike_reference_usd: strike,
      source: 'moomoo_same_day_chain_nearest_otm',
    },
    confirmation: {
      entry_confirmed: true,
      price_action_confirmed: true,
      node_reaction: trigger.node_reaction,
      closed_bar_at: bar.timestamp,
    },
    source_plan_session_date_et: plan.session_date_et,
    source_plan_message_id: plan.message_id,
    source_plan_channel_id: plan.channel_id,
    source_plan_author_id: plan.author_id,
    source_plan_event_id: plan.event_id,
    source_plan_strategy_title: plan.strategy_title,
    source_plan_weight_pct: scenarioWeight(plan, trigger.direction),
    source_daily_plan: plan,
    market_context: {
      ...market_context,
      bars_5m: market_context.bars_5m.slice(-20),
    },
    reason_codes: ['discord_daily_plan_trigger_confirmed'],
  };
}
