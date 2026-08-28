import { createHash } from 'node:crypto';
import {
  TRD_ENV_SIMULATE,
  buildOptionExecutionQuote,
  createMoomooQuoteFeed,
  fetchMoomooAccounts,
  findOptionContract,
  maskId,
  normalizeForJson,
  placeLimitBuyOrder,
  selectSimulatedUsOptionAccount,
} from '../../packages/moomoo-opend/moomoo-opend.mjs';
import { JUNK_GEX_MAX_AGE_MS } from './junk-gex-freshness.mjs';

export const ZERO_DTE_BUSINESS_LINE = 'zero-dte-options';
export const JUNK_MULTI_BUSINESS_LINE = 'junk-multi-options';
export const JUNK_FLOW_HEATMAP_BUSINESS_LINE = 'junk-flow-heatmap-options';
export const JUNK_GEX_STRATEGY = 'junk_gex_nodes_v3';
const SUPPORTED_JUNK_BUSINESS_LINES = Object.freeze([
  ZERO_DTE_BUSINESS_LINE,
  JUNK_MULTI_BUSINESS_LINE,
  JUNK_FLOW_HEATMAP_BUSINESS_LINE,
]);

const DEFAULT_ALLOWED_UNDERLYINGS = Object.freeze(['SPX', 'SPY']);
const DEFAULT_ALLOWED_NODE_REACTIONS = Object.freeze([
  'breakout_retest',
  'breakdown_retest',
  'rejection_retest',
  'node_rejection',
  'support_retest',
  'resistance_retest',
]);

function firstFinite(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function optionalPositiveGate(...values) {
  for (const value of values) {
    if (value === undefined || value === '') continue;
    if (value === null || value === false) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function finitePositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizedString(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function canonicalDirection(value) {
  const direction = normalizedString(value).toLowerCase();
  if (['bull', 'bullish', 'long', 'up'].includes(direction)) return 'bull';
  if (['bear', 'bearish', 'short', 'down'].includes(direction)) return 'bear';
  return direction;
}

function canonicalOptionType(value) {
  const type = normalizedString(value).toUpperCase();
  if (type === 'CALL') return 'C';
  if (type === 'PUT') return 'P';
  return type;
}

function boolFrom(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return false;
}

function isoOrNull(value) {
  const milliseconds = Date.parse(String(value ?? ''));
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function ageMs(value, now) {
  const milliseconds = Date.parse(String(value ?? ''));
  return Number.isFinite(milliseconds) ? now.getTime() - milliseconds : null;
}

function dateInNewYork(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function sessionMinutesInNewYork(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour === '24' ? 0 : values.hour);
  return hour * 60 + Number(values.minute);
}

function parseSessionMinutes(value, fallback) {
  const match = normalizedString(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    ? hour * 60 + minute
    : fallback;
}

function policyValue(config, section, key, fallback) {
  const value = config?.policy?.[section]?.[key];
  return value === undefined || value === null ? fallback : value;
}

function riskLimit(config, key, fallback) {
  return policyValue(config, 'risk_limits', key, fallback);
}

function expectedBusinessLine(config) {
  return normalizedString(
    config?.businessLine || config?.policy?.business_line?.id || config?.policy?.business_line,
    ZERO_DTE_BUSINESS_LINE,
  ).toLowerCase();
}

function expectedStrategy(config) {
  return normalizedString(config?.policy?.strategy?.id, JUNK_GEX_STRATEGY).toLowerCase();
}

function allowedUnderlyings(config) {
  const configured = riskLimit(config, 'allowed_underlyings', DEFAULT_ALLOWED_UNDERLYINGS);
  const values = Array.isArray(configured) ? configured : String(configured || '').split(',');
  return new Set(values.map((value) => normalizedString(value).toUpperCase()).filter(Boolean));
}

export function zeroDtePolicyQuoteConfig(config) {
  const quality = config?.policy?.execution_quality || {};
  return {
    optionRequireBidAsk: quality.require_bid_ask ?? true,
    optionRequireTickSize: quality.require_tick_size ?? true,
    optionRequireOpenInterestAndVolume: quality.require_open_interest_and_volume === true,
    optionMinBidPrice: firstFinite(quality.min_bid_price, config.optionMinBidPrice, 0.01),
    optionMaxSpreadPctOfMid: optionalPositiveGate(quality.max_spread_pct_of_mid, config.optionMaxSpreadPctOfMid),
    optionMaxSpreadAbs: firstFinite(quality.max_spread_abs, config.optionMaxSpreadAbs),
    optionMaxRoundTripLossPct: optionalPositiveGate(quality.max_round_trip_loss_pct, config.optionMaxRoundTripLossPct),
    optionSlippageTicks: firstFinite(quality.slippage_ticks, config.optionSlippageTicks, 1),
    optionSlippagePctOfSpread: firstFinite(quality.slippage_pct_of_spread, config.optionSlippagePctOfSpread, 20),
    optionMinOpenInterest: firstFinite(quality.min_open_interest, config.optionMinOpenInterest, 100),
    optionMinDayVolume: firstFinite(quality.min_option_day_volume, config.optionMinDayVolume, 100),
    optionExitStopLossPct: firstFinite(
      config?.policy?.exit_rules?.option_stop_loss_pct,
      config.optionExitStopLossPct,
      15,
    ),
  };
}

function sizingSettings(config) {
  const sizing = config?.policy?.position_sizing || {};
  const quality = config?.policy?.execution_quality || {};
  return {
    paper_equity_usd: firstFinite(sizing.paper_equity_usd, config.paperEquityUsd, 10_000),
    target_position_pct: firstFinite(sizing.target_position_pct, config.targetPositionPct, 5),
    min_position_pct: firstFinite(sizing.min_position_pct, config.minPositionPct, 1),
    max_position_pct: firstFinite(sizing.max_position_pct, config.maxPositionPct, 10),
    contract_multiplier_default: firstFinite(
      sizing.contract_multiplier_default,
      config.contractMultiplierDefault,
      100,
    ),
    cap_qty_by_visible_ask: quality.cap_qty_by_visible_ask ?? true,
    max_qty_to_ask_volume_ratio: firstFinite(quality.max_qty_to_ask_volume_ratio, 1),
  };
}

function calculatePositionSizing(optionPrice, contractMultiplier, quote, config) {
  const settings = sizingSettings(config);
  const price = finitePositive(optionPrice);
  const multiplier = finitePositive(contractMultiplier) || settings.contract_multiplier_default;
  const equity = finitePositive(settings.paper_equity_usd);
  const targetPct = finitePositive(settings.target_position_pct);
  const maxPct = finitePositive(settings.max_position_pct);
  const minPct = finitePositive(settings.min_position_pct) || 0;
  const reasons = [];

  if (price === null || multiplier === null || equity === null || targetPct === null || maxPct === null) {
    return { status: 'invalid_sizing_inputs', qty: 0, reasons: ['invalid_sizing_inputs'] };
  }

  const contractCost = price * multiplier;
  const targetBudget = equity * targetPct / 100;
  const maxBudget = equity * maxPct / 100;
  if (contractCost > equity) {
    return {
      status: 'contract_cost_above_paper_equity',
      qty: 0,
      reasons: ['contract_cost_above_paper_equity'],
      option_price: price,
      contract_multiplier: multiplier,
      contract_cost_usd: Number(contractCost.toFixed(2)),
      paper_equity_usd: equity,
      max_position_usd: Number(maxBudget.toFixed(2)),
    };
  }

  const maxQtyByBudget = Math.floor(maxBudget / contractCost);
  let qty;
  if (maxQtyByBudget < 1) {
    // Options trade in whole contracts. Treat max_position_pct as a sizing
    // target, not a hard rejection: one contract may exceed that percentage
    // while still remaining inside the complete $10k virtual line.
    qty = 1;
    reasons.push('minimum_contract_above_max_position_target');
  } else {
    qty = Math.max(1, Math.round(targetBudget / contractCost));
    qty = Math.min(qty, maxQtyByBudget);
  }

  const rawAskSize = firstFinite(quote?.ask_size_contracts);
  const askSize = finitePositive(rawAskSize);
  if (settings.cap_qty_by_visible_ask) {
    if (askSize === null) {
      reasons.push(rawAskSize === null ? 'visible_ask_size_missing' : 'visible_ask_size_nonpositive');
      qty = 0;
    } else {
      const cap = Math.max(1, Math.floor(askSize * settings.max_qty_to_ask_volume_ratio));
      if (qty > cap) {
        reasons.push(`qty_capped_by_visible_ask_liquidity:${qty}->${cap}`);
        qty = cap;
      }
    }
  }

  const estimatedPosition = qty * contractCost;
  const estimatedPct = estimatedPosition / equity * 100;
  if (estimatedPct < minPct) reasons.push('position_below_min_due_to_contract_granularity');

  return {
    status: qty > 0 ? 'ok' : 'position_sizing_failed',
    qty,
    reasons,
    option_price: price,
    contract_multiplier: multiplier,
    contract_cost_usd: Number(contractCost.toFixed(2)),
    paper_equity_usd: equity,
    target_position_pct: targetPct,
    min_position_pct: minPct,
    max_position_pct: maxPct,
    max_position_is_soft_target: true,
    target_position_usd: Number(targetBudget.toFixed(2)),
    max_position_usd: Number(maxBudget.toFixed(2)),
    estimated_position_usd: Number(estimatedPosition.toFixed(2)),
    estimated_position_pct: Number(estimatedPct.toFixed(2)),
  };
}

function inferredNodeReaction(signal) {
  const explicit = normalizedString(
    signal?.node_reaction || signal?.confirmation?.node_reaction || signal?.entry_confirmation?.node_reaction,
  ).toLowerCase();
  if (explicit) return explicit;
  const signalType = normalizedString(signal?.signal_type || signal?.setup_type).toLowerCase();
  if (signalType.includes('breakout')) return 'breakout_retest';
  if (signalType.includes('breakdown')) return 'breakdown_retest';
  if (signalType.includes('rejection')) return 'rejection_retest';
  return signalType;
}

function strictZeroDteContract(resolved, signal) {
  if (!resolved?.found || !resolved.contract) return null;
  const current_code = normalizedString(resolved.contract?.security?.code).toUpperCase();
  if (signal.ticker !== 'SPX' || current_code.startsWith('SPXW')) return resolved.contract;
  const leg_name = signal.option_type === 'C' ? 'call' : 'put';
  const candidates = [];
  for (const chain of resolved.response?.s2c?.optionChain || []) {
    for (const item of chain.option || []) {
      const info = item?.[leg_name];
      const code = normalizedString(info?.basic?.security?.code).toUpperCase();
      const option_data = info?.optionExData || {};
      const expiration = normalizedString(option_data.strikeTime || chain.strikeTime).slice(0, 10);
      const strike = firstFinite(option_data.strikePrice);
      if (!code.startsWith('SPXW') || expiration !== signal.expiration
        || strike === null || Math.abs(strike - signal.strike) > 0.0001) continue;
      candidates.push({
        security: info.basic.security,
        name: normalizedString(info.basic.name),
        lotSize: firstFinite(info.basic.lotSize),
        strikeTime: expiration,
        strikePrice: strike,
        optionType: option_data.type,
        owner: option_data.owner,
        suspend: option_data.suspend,
        raw: info,
      });
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function derivedSignalId(signal) {
  const explicit = normalizedString(signal?.signal_id || signal?.id);
  if (explicit) return explicit;
  const testedStrike = firstFinite(signal?.tested_node?.strike_usd, signal?.trigger_price, signal?.entry_reference_usd);
  const identity = [
    signal?.business_line,
    signal?.strategy,
    signal?.ticker,
    signal?.snapshot_at || signal?.gex_snapshot_at,
    signal?.direction,
    signal?.signal_type,
    testedStrike,
  ].map((value) => String(value ?? '')).join('|');
  if (!identity.replaceAll('|', '')) return '';
  return `junk_gex_${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
}

function normalizeSignal(signal, now = new Date()) {
  const confirmation = signal?.confirmation || signal?.entry_confirmation || {};
  const marketContext = signal?.market_context || {};
  const evidenceModel = signal?.evidence_model || {};
  const reasonCodes = new Set(Array.isArray(signal?.reason_codes) ? signal.reason_codes.map(String) : []);
  const zeroDteSelected = Number(signal?.option_selection?.expiry_days) === 0;
  return {
    signal_id: derivedSignalId(signal),
    business_line: normalizedString(signal?.business_line, ZERO_DTE_BUSINESS_LINE).toLowerCase(),
    strategy: normalizedString(signal?.strategy, JUNK_GEX_STRATEGY).toLowerCase(),
    model_version: normalizedString(signal?.model_version) || null,
    generated_at: isoOrNull(signal?.generated_at || signal?.created_at || signal?.snapshot_at),
    ticker: normalizedString(signal?.ticker).toUpperCase(),
    expiration: normalizedString(signal?.expiration || (zeroDteSelected ? dateInNewYork(now) : '')).slice(0, 10),
    strike: firstFinite(signal?.strike, signal?.option_selection?.strike_reference_usd),
    option_type: canonicalOptionType(signal?.option_type || signal?.option_selection?.option_right),
    direction: canonicalDirection(signal?.direction),
    entry_confirmed: boolFrom(
      signal?.entry_confirmed,
      confirmation.entry_confirmed,
      signal?.decision === 'trade' && signal?.action === 'open_long_option',
    ),
    price_action_confirmed: boolFrom(
      signal?.price_action_confirmed,
      confirmation.price_action_confirmed,
      confirmation.price_action,
      reasonCodes.has('gex_node_confirmed'),
    ),
    node_reaction: inferredNodeReaction(signal),
    trigger_price: firstFinite(
      signal?.trigger_price,
      signal?.node_price,
      signal?.entry_reference_usd,
      confirmation.trigger_price,
    ),
    invalidation_price: firstFinite(
      signal?.invalidation_price,
      signal?.stop_price,
      signal?.stop_underlying_usd,
    ),
    invalidation_basis: normalizedString(signal?.invalidation_basis) || null,
    target_price: firstFinite(
      signal?.target_price,
      signal?.next_node_price,
      signal?.target_underlying_usd,
    ),
    gex_snapshot_at: isoOrNull(
      signal?.gex_snapshot_at || signal?.snapshot_at || marketContext.gex_snapshot_at,
    ),
    gex_state: normalizedString(
      signal?.gex_state || signal?.snapshot_state || marketContext.gex_state,
    ).toLowerCase(),
    heatmap_assessment: normalizedString(evidenceModel?.heatmap?.assessment).toLowerCase() || 'neutral',
    automated_flow_assessment: normalizedString(
      evidenceModel?.automated_flow?.assessment,
    ).toLowerCase() || 'neutral',
    evidence_source_message_ids: [...new Set(
      (Array.isArray(evidenceModel?.source_message_ids) ? evidenceModel.source_message_ids : [])
        .map((value) => normalizedString(value))
        .filter(Boolean),
    )].slice(0, 50),
    evidence_source_event_ids: [...new Set(
      (Array.isArray(evidenceModel?.source_event_ids) ? evidenceModel.source_event_ids : [])
        .map((value) => normalizedString(value))
        .filter(Boolean),
    )].slice(0, 100),
    discord_flow_dependency: boolFrom(
      signal?.discord_flow_dependency,
      signal?.requires_discord_flow,
      confirmation.discord_flow_dependency,
    ) || (
      Boolean(normalizedString(signal?.flow_dependency))
      && normalizedString(signal?.flow_dependency).toLowerCase() !== 'none'
    ),
  };
}

function normalizeIdList(value) {
  if (value instanceof Set) return new Set([...value].map(String));
  return new Set((Array.isArray(value) ? value : []).map(String));
}

function validateSignal(signal, config, riskState, now) {
  const reasons = [];
  const maxSignalAgeMs = firstFinite(riskLimit(config, 'max_signal_age_seconds', 60), 60) * 1000;
  const defaultGexAgeSeconds = JUNK_GEX_MAX_AGE_MS / 1_000;
  const maxGexAgeMs = firstFinite(
    riskLimit(config, 'max_gex_snapshot_age_seconds', defaultGexAgeSeconds),
    defaultGexAgeSeconds,
  ) * 1000;
  const maxFutureSkewMs = firstFinite(riskLimit(config, 'max_future_clock_skew_seconds', 5), 5) * 1000;
  const signalAge = ageMs(signal.generated_at, now);
  const gexAge = ageMs(signal.gex_snapshot_at, now);
  const sessionMinutes = sessionMinutesInNewYork(now);
  const entryStartMinutes = parseSessionMinutes(config?.policy?.strategy?.entry_start_time_et, 9 * 60 + 30);
  const entryCutoffMinutes = parseSessionMinutes(config?.policy?.strategy?.entry_cutoff_time_et, 15 * 60 + 45);

  if (!signal.signal_id) reasons.push('missing_signal_id');
  const requiredBusinessLine = expectedBusinessLine(config);
  const requiredStrategy = expectedStrategy(config);
  if (signal.business_line !== requiredBusinessLine) reasons.push(`wrong_business_line:${signal.business_line}`);
  if (signal.strategy !== requiredStrategy) reasons.push(`wrong_strategy:${signal.strategy}`);
  if (!allowedUnderlyings(config).has(signal.ticker)) reasons.push(`underlying_not_allowed:${signal.ticker}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signal.expiration)) reasons.push('invalid_expiration');
  if (signal.expiration && signal.expiration !== dateInNewYork(now)) reasons.push('not_zero_dte_expiration');
  if (finitePositive(signal.strike) === null) reasons.push('invalid_strike');
  if (!['C', 'P'].includes(signal.option_type)) reasons.push('invalid_option_type');
  if (!['bull', 'bear'].includes(signal.direction)) reasons.push('invalid_direction');
  if (signal.direction === 'bull' && signal.option_type !== 'C') reasons.push('direction_option_type_mismatch');
  if (signal.direction === 'bear' && signal.option_type !== 'P') reasons.push('direction_option_type_mismatch');
  if (signal.entry_confirmed !== true) reasons.push('entry_not_confirmed');
  if (signal.price_action_confirmed !== true) reasons.push('price_action_not_confirmed');
  if (!DEFAULT_ALLOWED_NODE_REACTIONS.includes(signal.node_reaction)) reasons.push(`unsupported_node_reaction:${signal.node_reaction}`);
  if (signal.discord_flow_dependency) reasons.push('discord_flow_dependency_forbidden');
  if (sessionMinutes < entryStartMinutes) reasons.push('before_entry_start_time_et');
  if (sessionMinutes >= entryCutoffMinutes) reasons.push('after_entry_cutoff_time_et');
  if (signal.gex_state !== 'fresh') reasons.push(`gex_state_not_fresh:${signal.gex_state || 'missing'}`);
  if (signalAge === null) reasons.push('invalid_generated_at');
  if (signalAge !== null && signalAge > maxSignalAgeMs) reasons.push(`signal_stale:${signalAge}`);
  if (signalAge !== null && signalAge < -maxFutureSkewMs) reasons.push(`signal_from_future:${signalAge}`);
  if (gexAge === null) reasons.push('invalid_gex_snapshot_at');
  if (gexAge !== null && gexAge > maxGexAgeMs) reasons.push(`gex_snapshot_stale:${gexAge}`);
  if (gexAge !== null && gexAge < -maxFutureSkewMs) reasons.push(`gex_snapshot_from_future:${gexAge}`);

  const trigger = finitePositive(signal.trigger_price);
  const invalidation = finitePositive(signal.invalidation_price);
  const target = finitePositive(signal.target_price);
  if (trigger === null) reasons.push('invalid_trigger_price');
  if (invalidation === null) reasons.push('invalid_invalidation_price');
  if (target === null) reasons.push('invalid_target_price');
  if (signal.direction === 'bull' && trigger !== null && invalidation !== null && invalidation >= trigger) {
    reasons.push('bull_invalidation_not_below_trigger');
  }
  if (signal.direction === 'bull' && trigger !== null && target !== null && target <= trigger) {
    reasons.push('bull_target_not_above_trigger');
  }
  if (signal.direction === 'bear' && trigger !== null && invalidation !== null && invalidation <= trigger) {
    reasons.push('bear_invalidation_not_above_trigger');
  }
  if (signal.direction === 'bear' && trigger !== null && target !== null && target >= trigger) {
    reasons.push('bear_target_not_below_trigger');
  }

  const seenSignalIds = normalizeIdList(riskState?.executed_signal_ids || riskState?.seen_signal_ids);
  if (signal.signal_id && seenSignalIds.has(signal.signal_id)) reasons.push('duplicate_signal_id');
  const openPositionCount = firstFinite(riskState?.open_position_count, 0);
  const maxOpenPositions = firstFinite(riskLimit(config, 'max_open_positions', 1), 1);
  if (openPositionCount >= maxOpenPositions) reasons.push(`max_open_positions_reached:${openPositionCount}`);
  const dailyTradeCount = firstFinite(riskState?.daily_trade_count, 0);
  const maxTradesPerDay = finitePositive(riskLimit(config, 'max_trades_per_day', null));
  if (maxTradesPerDay !== null && dailyTradeCount >= maxTradesPerDay) {
    reasons.push(`max_trades_per_day_reached:${dailyTradeCount}`);
  }
  const dailyRealizedPnlUsd = firstFinite(riskState?.daily_realized_pnl_usd, 0);
  const maxDailyRealizedLossUsd = finitePositive(riskLimit(config, 'max_daily_realized_loss_usd', null));
  if (maxDailyRealizedLossUsd !== null && dailyRealizedPnlUsd <= -maxDailyRealizedLossUsd) {
    reasons.push(`max_daily_realized_loss_reached:${dailyRealizedPnlUsd}`);
  }
  const cooldownMs = firstFinite(config?.policy?.strategy?.cooldown_seconds, 0) * 1000;
  const lastEntryAgeMs = ageMs(riskState?.last_entry_at, now);
  if (cooldownMs > 0 && lastEntryAgeMs !== null && lastEntryAgeMs >= 0 && lastEntryAgeMs < cooldownMs) {
    reasons.push(`entry_cooldown_active:${lastEntryAgeMs}`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    signal_age_ms: signalAge,
    gex_snapshot_age_ms: gexAge,
    max_signal_age_ms: maxSignalAgeMs,
    max_gex_snapshot_age_ms: maxGexAgeMs,
  };
}

function contractMultiplier(contract, snapshot, config) {
  return firstFinite(
    snapshot?.optionExData?.contractMultiplier,
    snapshot?.optionExData?.contractSizeFloat,
    snapshot?.optionExData?.contractSize,
    contract?.lotSize,
    sizingSettings(config).contract_multiplier_default,
  );
}

function deterministicPlanId(signal, contractCode) {
  const digest = createHash('sha256')
    .update(`${signal.signal_id}|${contractCode || ''}|${signal.generated_at || ''}`)
    .digest('hex')
    .slice(0, 20);
  return `zero_dte_${digest}`;
}

export function assertZeroDteSimulationOnly(config) {
  const businessLine = expectedBusinessLine(config);
  if (!SUPPORTED_JUNK_BUSINESS_LINES.includes(businessLine)) {
    throw new Error(`Moomoo executor rejects unsupported JUNK business line ${businessLine || 'missing'}.`);
  }

  const policyEnvironment = normalizedString(
    config?.policyExecutionEnvironment || config?.policy?.execution?.environment,
  ).toLowerCase();
  if (policyEnvironment !== 'simulate_only') {
    throw new Error(`${businessLine} policy must set execution.environment=simulate_only.`);
  }

  const policyRealTradingAllowed = config?.policyRealTradingAllowed
    ?? config?.policy?.execution?.real_trading_allowed;
  if (policyRealTradingAllowed !== false) {
    throw new Error(`${businessLine} policy must set execution.real_trading_allowed=false.`);
  }

  if (Number(config?.trdEnv) !== TRD_ENV_SIMULATE) {
    throw new Error(`${businessLine} executor rejects every non-simulated trading environment.`);
  }
  return true;
}

export function buildZeroDteSimulatedEntryPlan({
  signal: rawSignal,
  contract,
  option_snapshot: optionSnapshot,
  config,
  risk_state: riskState = {},
  now = new Date(),
} = {}) {
  assertZeroDteSimulationOnly(config);
  const signal = normalizeSignal(rawSignal || {}, now);
  const validation = validateSignal(signal, config, riskState, now);
  const reasons = [...validation.reasons];
  const contractCode = normalizedString(contract?.security?.code);

  if (!contractCode) reasons.push('missing_moomoo_option_contract');
  if (signal.ticker === 'SPX' && contractCode && !contractCode.toUpperCase().startsWith('SPXW')) {
    reasons.push('spx_zero_dte_contract_must_be_spxw_pm_settled');
  }
  const contractExpiration = normalizedString(contract?.strikeTime).slice(0, 10);
  const contractStrike = firstFinite(contract?.strikePrice);
  if (contractCode && contractExpiration && contractExpiration !== signal.expiration) {
    reasons.push(`contract_expiration_mismatch:${contractExpiration}`);
  }
  if (contractCode && contractStrike !== null && Math.abs(contractStrike - signal.strike) > 0.0001) {
    reasons.push(`contract_strike_mismatch:${contractStrike}`);
  }
  const quoteConfig = zeroDtePolicyQuoteConfig(config);
  const executionQuality = optionSnapshot
    ? buildOptionExecutionQuote(optionSnapshot, quoteConfig)
    : { tradeable: false, reasons: ['missing_option_snapshot'], buy_limit_price: null };
  if (!executionQuality.tradeable) {
    reasons.push(...executionQuality.reasons.map((reason) => `option_quote_quality:${reason}`));
  }
  const quoteAge = ageMs(executionQuality.quote_received_at, now);
  const maxQuoteAgeMs = firstFinite(riskLimit(config, 'max_option_quote_age_seconds', 3), 3) * 1000;
  if (optionSnapshot && quoteAge === null) reasons.push('invalid_option_quote_received_at');
  if (quoteAge !== null && quoteAge > maxQuoteAgeMs) reasons.push(`option_quote_stale:${quoteAge}`);
  if (quoteAge !== null && quoteAge < -5_000) reasons.push(`option_quote_from_future:${quoteAge}`);

  const sizing = calculatePositionSizing(
    executionQuality.buy_limit_price,
    contractMultiplier(contract, optionSnapshot, config),
    executionQuality,
    config,
  );
  if (sizing.qty < 1) reasons.push(...sizing.reasons.map((reason) => `position_sizing:${reason}`));

  const gate = {
    passed: reasons.length === 0,
    reasons: [...new Set(reasons)],
    signal_age_ms: validation.signal_age_ms,
    gex_snapshot_age_ms: validation.gex_snapshot_age_ms,
    max_signal_age_ms: validation.max_signal_age_ms,
    max_gex_snapshot_age_ms: validation.max_gex_snapshot_age_ms,
    option_quote_age_ms: quoteAge,
    max_option_quote_age_ms: maxQuoteAgeMs,
  };
  const plannedAt = now.toISOString();
  const line = expectedBusinessLine(config);
  const remarkPrefix = line === JUNK_MULTI_BUSINESS_LINE
    ? 'junk_multi'
    : (line === JUNK_FLOW_HEATMAP_BUSINESS_LINE ? 'junk_flow_hm' : 'junk_gex');
  const remark = `${remarkPrefix}:${signal.signal_id}`.slice(0, 60);
  const exitRules = config?.policy?.exit_rules || {};

  return {
    schema_version: 1,
    plan_id: deterministicPlanId(signal, contractCode),
    planned_at: plannedAt,
    business_line: expectedBusinessLine(config),
    strategy: expectedStrategy(config),
    mode: 'simulate',
    order_status: gate.passed ? 'ready_for_simulation' : 'gate_failed',
    gate,
    signal,
    contract: contractCode ? {
      code: contractCode,
      market: firstFinite(contract?.security?.market),
      name: normalizedString(contract?.name),
      expiration: normalizedString(contract?.strikeTime).slice(0, 10) || signal.expiration,
      strike: firstFinite(contract?.strikePrice, signal.strike),
      option_type: signal.option_type,
      lot_size: firstFinite(contract?.lotSize),
    } : null,
    quote: {
      quote_source: executionQuality.quote_source || null,
      quote_received_at: isoOrNull(executionQuality.quote_received_at),
      bid_ask_source: executionQuality.bid_ask_source || null,
      bid_ask_received_at: isoOrNull(executionQuality.bid_ask_received_at),
      bid: executionQuality.bid ?? null,
      ask: executionQuality.ask ?? null,
      mid: executionQuality.mid ?? null,
      spread_abs: executionQuality.spread_abs ?? null,
      spread_pct_of_mid: executionQuality.spread_pct_of_mid ?? null,
      buy_limit_price: executionQuality.buy_limit_price ?? null,
      sell_estimate_price: executionQuality.sell_estimate_price ?? null,
      immediate_round_trip_loss_pct: executionQuality.immediate_round_trip_loss_pct ?? null,
      ask_size_contracts: executionQuality.ask_size_contracts ?? null,
      bid_size_contracts: executionQuality.bid_size_contracts ?? null,
      day_volume_contracts: executionQuality.day_volume_contracts ?? null,
      open_interest: executionQuality.open_interest ?? null,
    },
    position_sizing: sizing,
    order: gate.passed ? {
      side: 'buy_to_open',
      order_type: 'limit',
      code: contractCode,
      qty: sizing.qty,
      price: executionQuality.buy_limit_price,
      price_basis: executionQuality.buy_limit_basis,
      time_in_force: 'day',
      remark,
      option_exit_rules: {
        price_basis: 'option_entry_fill_price',
        catastrophic_stop_loss_pct: firstFinite(
          exitRules.catastrophic_stop_loss_pct,
          exitRules.option_stop_loss_pct,
          config.optionExitStopLossPct,
          25,
        ),
        stop_loss_return_pct: firstFinite(
          exitRules.catastrophic_stop_loss_pct,
          exitRules.option_stop_loss_pct,
          config.optionExitStopLossPct,
          25,
        ),
        breakeven_activation_pct: firstFinite(exitRules.breakeven_activation_pct, 20),
        breakeven_floor_pct: firstFinite(exitRules.breakeven_floor_pct, 0),
        option_take_profit_enabled: exitRules.option_take_profit_enabled === true,
        take_profit_return_pct: firstFinite(exitRules.option_take_profit_pct, config.optionExitTakeProfitPct, 25),
        exit_before_regular_session_close: exitRules.exit_before_regular_session_close ?? true,
        close_exit_start_time_et: normalizedString(exitRules.close_exit_start_time_et, config.closeExitStartTimeEt || '15:45'),
        force_close_exit_start_time_et: normalizedString(exitRules.force_close_exit_start_time_et, config.forceCloseExitStartTimeEt || '15:55'),
        no_overnight_holding: exitRules.no_overnight_holding ?? true,
      },
    } : null,
    provenance: {
      nightwatch_gex_used: true,
      nightwatch_heatmap_context_used: signal.heatmap_assessment === 'confirm',
      moomoo_price_action_used: true,
      discord_flow_used: false,
      manual_discord_flow_used: false,
      automated_discord_flow_context_used: signal.automated_flow_assessment === 'confirm',
      automated_discord_flow_dependency: false,
      source_message_ids: signal.evidence_source_message_ids,
      source_event_ids: signal.evidence_source_event_ids,
    },
  };
}

export async function prepareZeroDteSimulatedEntry({
  client,
  signal,
  config,
  risk_state: riskState = {},
  now = new Date(),
  quote_feed: providedQuoteFeed = null,
  dependencies = {},
} = {}) {
  assertZeroDteSimulationOnly(config);
  if (!client) throw new Error('Moomoo client is required.');
  const resolveContract = dependencies.find_option_contract || findOptionContract;
  const quoteFeed = providedQuoteFeed || (dependencies.create_quote_feed || createMoomooQuoteFeed)(client, config);
  const ownsQuoteFeed = !providedQuoteFeed;

  try {
    const normalized = normalizeSignal(signal || {}, now);
    const resolved = await resolveContract(client, normalized);
    const strict_contract = strictZeroDteContract(resolved, normalized);
    if (!strict_contract) {
      return buildZeroDteSimulatedEntryPlan({
        signal,
        contract: null,
        option_snapshot: null,
        config,
        risk_state: riskState,
        now,
      });
    }
    const security = strict_contract.security;
    const quoteResult = await quoteFeed.getSnapshots([security], { orderBookSecurities: [security] });
    const snapshots = quoteResult?.snapshots || [];
    const optionSnapshot = snapshots.find((item) => item?.basic?.security?.code === security.code)
      || snapshots[0]
      || null;
    return buildZeroDteSimulatedEntryPlan({
      signal,
      contract: strict_contract,
      option_snapshot: optionSnapshot,
      config,
      risk_state: riskState,
      now,
    });
  } finally {
    if (ownsQuoteFeed) await quoteFeed.close?.();
  }
}

function brokerExecutionSummary(response) {
  const payload = response?.s2c || {};
  return {
    broker_order_id: normalizedString(payload.orderID || payload.orderId) || null,
    broker_order_id_ex: normalizedString(payload.orderIDEx || payload.orderIdEx) || null,
  };
}

function classifiedSubmissionError(error, submissionOutcome, submissionPhase) {
  const resolved = error instanceof Error ? error : new Error(`${submissionPhase} failed.`);
  resolved.submission_outcome = submissionOutcome;
  resolved.submission_phase = submissionPhase;
  return resolved;
}

function explicitBrokerPlaceOrderRejection(error) {
  const message = String(error?.message || '');
  return /^PlaceOrder failed: retType=(?!unknown(?:\s|$))[^\s]+\b/.test(message);
}

async function runBrokerStage(operation, {
  timeout_ms: timeoutMs = 10_000,
  submission_outcome: submissionOutcome,
  submission_phase: submissionPhase,
} = {}) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${submissionPhase} timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    const resolvedOutcome = submissionOutcome === 'unknown' && explicitBrokerPlaceOrderRejection(error)
      ? 'not_submitted'
      : submissionOutcome;
    throw classifiedSubmissionError(error, resolvedOutcome, submissionPhase);
  } finally {
    clearTimeout(timer);
  }
}

export async function executeZeroDteSimulatedEntry({
  client,
  config,
  plan,
  now = new Date(),
  dependencies = {},
} = {}) {
  assertZeroDteSimulationOnly(config);
  if (!client) throw new Error('Moomoo client is required.');
  if (plan?.business_line !== expectedBusinessLine(config) || plan?.strategy !== expectedStrategy(config)) {
    throw new Error('Execution plan does not belong to the isolated junk GEX business line.');
  }
  if (plan?.mode !== 'simulate') throw new Error('Only simulated execution plans are accepted.');
  if (!plan?.gate?.passed || plan?.order_status !== 'ready_for_simulation' || !plan?.order) {
    return {
      ...plan,
      order_status: 'not_submitted',
      execution: {
        submitted: false,
        reason: 'plan_gate_not_passed',
      },
    };
  }

  const executionGateReasons = [];
  const planAgeMs = ageMs(plan.planned_at, now);
  const entryOrderTtlMs = firstFinite(riskLimit(config, 'entry_order_ttl_seconds', 45), 45) * 1000;
  if (planAgeMs === null) executionGateReasons.push('invalid_plan_timestamp');
  if (planAgeMs !== null && planAgeMs > entryOrderTtlMs) executionGateReasons.push(`entry_plan_expired:${planAgeMs}`);
  if (planAgeMs !== null && planAgeMs < -5_000) executionGateReasons.push(`entry_plan_from_future:${planAgeMs}`);
  if (plan.order.code !== plan.contract?.code) executionGateReasons.push('order_contract_code_mismatch');
  if (Number(plan.order.qty) !== Number(plan.position_sizing?.qty)) executionGateReasons.push('order_qty_mismatch');
  if (Number(plan.order.price) !== Number(plan.quote?.buy_limit_price)) executionGateReasons.push('order_price_mismatch');
  if (executionGateReasons.length > 0) {
    return {
      ...plan,
      order_status: 'not_submitted',
      execution: {
        submitted: false,
        reason: 'execution_revalidation_failed',
        reasons: executionGateReasons,
        plan_age_ms: planAgeMs,
        entry_order_ttl_ms: entryOrderTtlMs,
      },
    };
  }

  const getAccounts = dependencies.fetch_accounts || fetchMoomooAccounts;
  const selectAccount = dependencies.select_simulated_option_account || selectSimulatedUsOptionAccount;
  const submitOrder = dependencies.place_limit_buy_order || placeLimitBuyOrder;
  const preflightTimeoutMs = Number(dependencies.preflight_timeout_ms) > 0
    ? Number(dependencies.preflight_timeout_ms)
    : 10_000;
  const submitTimeoutMs = Number(dependencies.submit_timeout_ms) > 0
    ? Number(dependencies.submit_timeout_ms)
    : 15_000;
  const accounts = await runBrokerStage(
    () => getAccounts(client),
    {
      timeout_ms: preflightTimeoutMs,
      submission_outcome: 'not_submitted',
      submission_phase: 'entry_account_preflight',
    },
  );
  const account = await runBrokerStage(
    () => selectAccount(accounts),
    {
      timeout_ms: preflightTimeoutMs,
      submission_outcome: 'not_submitted',
      submission_phase: 'entry_account_selection',
    },
  );
  if (!account) {
    throw classifiedSubmissionError(
      new Error('No simulated US options account found in OpenD account list.'),
      'not_submitted',
      'entry_account_selection',
    );
  }
  if (Number(account.trdEnv) !== TRD_ENV_SIMULATE) {
    throw classifiedSubmissionError(
      new Error('Selected account is not a simulated account.'),
      'not_submitted',
      'entry_account_selection',
    );
  }

  const executionConfig = {
    ...config,
    trdEnv: TRD_ENV_SIMULATE,
    accId: String(account.accID || ''),
  };
  const response = await runBrokerStage(
    () => submitOrder(client, executionConfig, {
      code: plan.order.code,
      qty: plan.order.qty,
      price: plan.order.price,
      remark: plan.order.remark,
    }),
    {
      timeout_ms: submitTimeoutMs,
      submission_outcome: 'unknown',
      submission_phase: 'entry_place_order',
    },
  );

  return {
    ...plan,
    order_status: 'submitted_simulation',
    execution: {
      submitted: true,
      submitted_at: now.toISOString(),
      simulated_account_id: maskId(account.accID),
      ...brokerExecutionSummary(normalizeForJson(response)),
    },
  };
}
