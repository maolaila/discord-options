import {
  TRD_ENV_SIMULATE,
  buildOptionExecutionQuote,
  fetchMoomooAccounts,
  fetchPositionList,
  maskId,
  normalizeForJson,
  placeLimitSellOrder,
  placeMarketSellOrder,
  selectSimulatedUsOptionAccount,
} from '../../packages/moomoo-opend/moomoo-opend.mjs';
import {
  JUNK_GEX_STRATEGY,
  JUNK_FLOW_HEATMAP_BUSINESS_LINE,
  JUNK_MULTI_BUSINESS_LINE,
  ZERO_DTE_BUSINESS_LINE,
  assertZeroDteSimulationOnly,
  zeroDtePolicyQuoteConfig,
} from './zero-dte-moomoo-executor.mjs';

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function nonnegativeNumber(value, fallback = 0) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : fallback;
}

function booleanSetting(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = normalizedString(value).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function boundedRatio(value, fallback = 0.5) {
  const parsed = positiveNumber(value);
  if (parsed === null) return fallback;
  return Math.min(1, parsed);
}

function normalizedStringList(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  return [...new Set(source.map((item) => normalizedString(item).toLowerCase()).filter(Boolean))];
}

function normalizedString(value) {
  return String(value ?? '').trim();
}

function expectedBusinessLine(config) {
  return normalizedString(
    config?.businessLine || config?.policy?.business_line?.id || config?.policy?.business_line,
  ).toLowerCase() || ZERO_DTE_BUSINESS_LINE;
}

function expectedStrategy(config) {
  return normalizedString(config?.policy?.strategy?.id).toLowerCase() || JUNK_GEX_STRATEGY;
}

function exitRemark(config, planId) {
  const line = expectedBusinessLine(config);
  const prefix = line === JUNK_MULTI_BUSINESS_LINE
    ? 'junk_multi_exit'
    : (line === JUNK_FLOW_HEATMAP_BUSINESS_LINE ? 'junk_flow_hm_exit' : 'junk_gex_exit');
  return `${prefix}:${normalizedString(planId).slice(-20)}`.slice(0, 60);
}

function nyParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: values.weekday,
    date_key: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour === '24' ? 0 : values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function parseEtMinutes(value, fallback) {
  const match = normalizedString(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return fallback;
  }
  return hour * 60 + minute;
}

function exitSettings(config) {
  const rules = config?.policy?.exit_rules || {};
  const catastrophicStopLossPct = positiveNumber(
    rules.catastrophic_stop_loss_pct
      ?? config.optionExitCatastrophicStopLossPct
      ?? config.catastrophicStopLossPct
      ?? rules.option_stop_loss_pct
      ?? config.optionExitStopLossPct,
  ) ?? 15;
  return {
    catastrophic_stop_loss_pct: catastrophicStopLossPct,
    // Deprecated output alias retained for readers of plans created before v2.
    stop_loss_pct: catastrophicStopLossPct,
    breakeven_activation_pct: positiveNumber(
      rules.breakeven_activation_pct
        ?? config.optionExitBreakevenActivationPct
        ?? config.breakevenActivationPct,
    ) ?? 20,
    breakeven_floor_pct: finiteNumber(
      rules.breakeven_floor_pct
        ?? config.optionExitBreakevenFloorPct
        ?? config.breakevenFloorPct,
    ) ?? 0,
    option_take_profit_enabled: booleanSetting(
      rules.option_take_profit_enabled
        ?? config.optionExitTakeProfitEnabled
        ?? config.optionTakeProfitEnabled,
      false,
    ),
    take_profit_pct: positiveNumber(rules.option_take_profit_pct ?? config.optionExitTakeProfitPct) ?? 25,
    option_price_exit: rules.option_price_exit ?? true,
    use_underlying_confirmation_bar_wick_invalidation:
      rules.use_underlying_confirmation_bar_wick_invalidation
      ?? rules.use_underlying_node_invalidation
      ?? true,
    use_next_gex_node_target: rules.use_next_gex_node_target ?? true,
    setup_time_stop_enabled: booleanSetting(
      rules.setup_time_stop_enabled
        ?? rules.setup_specific_time_stop_enabled
        ?? config.optionExitSetupTimeStopEnabled,
      true,
    ),
    setup_time_stop_minutes: positiveNumber(
      rules.setup_time_stop_minutes
        ?? rules.setup_specific_time_stop_minutes
        ?? config.optionExitSetupTimeStopMinutes,
    ) ?? 5,
    setup_time_stop_setup_types: normalizedStringList(
      rules.setup_time_stop_setup_types
        ?? rules.setup_specific_time_stop_setup_types,
      ['range_mean_reversion'],
    ),
    structural_target_partial_exit_enabled: booleanSetting(
      rules.structural_target_partial_exit_enabled
        ?? rules.partial_target_exit_enabled
        ?? config.optionExitStructuralTargetPartialEnabled,
      true,
    ),
    structural_target_partial_exit_ratio: boundedRatio(
      rules.structural_target_partial_exit_ratio
        ?? rules.partial_target_exit_ratio
        ?? config.optionExitStructuralTargetPartialRatio,
      0.5,
    ),
    structural_target_profit_floor_pct: finiteNumber(
      rules.structural_target_profit_floor_pct
        ?? rules.partial_target_profit_floor_pct
        ?? rules.partial_target_floor_pct
        ?? config.optionExitStructuralTargetProfitFloorPct,
    ) ?? 0,
    exit_before_regular_session_close: rules.exit_before_regular_session_close ?? true,
    close_exit_start_time_et: normalizedString(rules.close_exit_start_time_et || config.closeExitStartTimeEt || '15:45'),
    force_close_exit_start_time_et: normalizedString(rules.force_close_exit_start_time_et || config.forceCloseExitStartTimeEt || '15:55'),
    no_overnight_holding: rules.no_overnight_holding ?? true,
  };
}

function ownedQuantity(ownedPosition) {
  const filled = nonnegativeNumber(ownedPosition?.filled_qty);
  const exited = nonnegativeNumber(ownedPosition?.exited_qty);
  return Math.max(0, Math.floor(filled - exited));
}

function ownershipGate(ownedPosition, config) {
  const reasons = [];
  if (normalizedString(ownedPosition?.business_line) !== expectedBusinessLine(config)) {
    reasons.push('position_not_owned_by_zero_dte_line');
  }
  const ownedStrategy = normalizedString(ownedPosition?.strategy);
  if (![expectedStrategy(config), JUNK_GEX_STRATEGY, 'junk_gex_nodes_v2', 'junk_gex_nodes_v1'].includes(ownedStrategy)) {
    reasons.push('position_not_owned_by_junk_gex_strategy');
  }
  if (!normalizedString(ownedPosition?.plan_id).startsWith('zero_dte_')) reasons.push('missing_or_invalid_source_plan_id');
  if (!normalizedString(ownedPosition?.code)) reasons.push('missing_option_code');
  if (positiveNumber(ownedPosition?.entry_fill_price) === null) reasons.push('missing_entry_fill_price');
  if (ownedQuantity(ownedPosition) < 1) reasons.push('no_line_owned_remaining_qty');
  if (nonnegativeNumber(ownedPosition?.pending_exit_qty) > 0 || normalizedString(ownedPosition?.exit_order_id_ex)) {
    reasons.push('line_exit_already_pending');
  }
  return { passed: reasons.length === 0, reasons };
}

function optionReturnPct(entryPrice, exitPrice) {
  const entry = positiveNumber(entryPrice);
  const exit = positiveNumber(exitPrice);
  if (entry === null || exit === null) return null;
  return Number(((exit - entry) / entry * 100).toFixed(4));
}

function optionManagementUpdate(ownedPosition, quote, settings) {
  const currentPrice = positiveNumber(quote?.sell_estimate_price ?? quote?.bid);
  const currentReturnPct = optionReturnPct(ownedPosition?.entry_fill_price, currentPrice);
  const recordedPeakPct = finiteNumber(ownedPosition?.peak_option_return_pct);
  const peakOptionReturnPct = currentReturnPct === null
    ? recordedPeakPct
    : (recordedPeakPct === null ? currentReturnPct : Math.max(recordedPeakPct, currentReturnPct));
  const breakevenArmed = booleanSetting(ownedPosition?.breakeven_armed, false)
    || (peakOptionReturnPct !== null && peakOptionReturnPct >= settings.breakeven_activation_pct);
  const partialTargetTaken = booleanSetting(ownedPosition?.partial_target_taken, false);
  const recordedFloorPct = finiteNumber(
    ownedPosition?.management_floor_pct
      ?? ownedPosition?.profit_floor_pct
      ?? ownedPosition?.breakeven_floor_pct,
  );
  const update = {
    option_return_pct: currentReturnPct,
    peak_option_return_pct: peakOptionReturnPct,
    breakeven_armed: breakevenArmed || partialTargetTaken,
  };
  if (partialTargetTaken) {
    const managementFloorPct = Math.max(
      0,
      settings.structural_target_profit_floor_pct,
      recordedFloorPct ?? Number.NEGATIVE_INFINITY,
    );
    return {
      ...update,
      partial_target_taken: true,
      management_floor_pct: managementFloorPct,
      profit_floor_pct: managementFloorPct,
    };
  }
  return update;
}

function entryTimestampMs(ownedPosition) {
  for (const value of [
    ownedPosition?.entry_filled_at,
    ownedPosition?.entry_fill_at,
    ownedPosition?.entry_at,
    ownedPosition?.entry_submitted_at,
    ownedPosition?.filled_at,
    ownedPosition?.opened_at,
    ownedPosition?.entry_time,
  ]) {
    const parsed = Date.parse(normalizedString(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function targetReached({ direction, underlying, target }) {
  if (underlying === null || target === null) return false;
  if (direction === 'bull') return underlying >= target;
  if (direction === 'bear') return underlying <= target;
  return false;
}

function structuralTargetTrigger({
  ownedPosition,
  settings,
  managementUpdate,
  direction,
  underlying,
  target,
}) {
  if (!settings.use_next_gex_node_target || !targetReached({ direction, underlying, target })) return null;
  if (managementUpdate.partial_target_taken === true) return null;
  const remainingQty = ownedQuantity(ownedPosition);
  const partial = settings.structural_target_partial_exit_enabled && remainingQty >= 2;
  const requestedExitQty = partial
    ? Math.min(remainingQty - 1, Math.ceil(remainingQty * settings.structural_target_partial_exit_ratio))
    : remainingQty;
  return {
    reason: 'underlying_next_gex_node_target',
    trigger_type: 'underlying_structure',
    order_type: 'limit',
    underlying_price_usd: underlying,
    trigger_price_usd: target,
    structural_target_exit: partial ? 'partial' : 'full',
    requested_exit_qty: requestedExitQty,
    remaining_qty_before_exit: remainingQty,
    remaining_qty_after_requested_exit: Math.max(0, remainingQty - requestedExitQty),
  };
}

function setupTimeStopTrigger({ ownedPosition, settings, managementUpdate, now, direction, underlying, target }) {
  if (!settings.setup_time_stop_enabled) return null;
  const setupType = normalizedString(ownedPosition?.setup_type ?? ownedPosition?.node_reaction).toLowerCase();
  if (!settings.setup_time_stop_setup_types.includes(setupType)) return null;
  const entryMs = entryTimestampMs(ownedPosition);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(entryMs) || !Number.isFinite(nowMs) || nowMs < entryMs) return null;
  const targetAgeMs = settings.setup_time_stop_minutes * 60_000;
  const elapsedMs = nowMs - entryMs;
  if (elapsedMs < targetAgeMs) return null;
  if (target === null || underlying === null || targetReached({ direction, underlying, target })) return null;
  return {
    reason: `setup_${String(settings.setup_time_stop_minutes).replace('.', 'p')}m_time_stop_no_progress`,
    trigger_type: 'setup_time_stop',
    order_type: 'limit',
    setup_type: setupType,
    elapsed_ms: elapsedMs,
    elapsed_minutes: Number((elapsedMs / 60_000).toFixed(4)),
    underlying_price_usd: underlying,
    target_price_usd: target,
    option_return_pct: managementUpdate.option_return_pct,
  };
}

function partialTargetManagementUpdate(managementUpdate, settings, trigger) {
  if (trigger?.structural_target_exit !== 'partial') return managementUpdate;
  const previousFloorPct = finiteNumber(managementUpdate?.management_floor_pct);
  const managementFloorPct = Math.max(
    0,
    settings.structural_target_profit_floor_pct,
    previousFloorPct ?? Number.NEGATIVE_INFINITY,
  );
  return {
    ...managementUpdate,
    breakeven_armed: true,
    partial_target_taken: true,
    partial_target_taken_now: true,
    partial_target_exit_qty: trigger.requested_exit_qty,
    management_floor_pct: managementFloorPct,
    profit_floor_pct: managementFloorPct,
    profit_floor_raised: previousFloorPct === null || managementFloorPct > previousFloorPct,
  };
}

function exitTrigger({ ownedPosition, quote, settings, managementUpdate, now, underlyingPrice }) {
  const ny = nyParts(now);
  const minutes = ny.hour * 60 + ny.minute;
  const closeMinutes = parseEtMinutes(settings.close_exit_start_time_et, 15 * 60 + 30);
  const forceMinutes = parseEtMinutes(settings.force_close_exit_start_time_et, 15 * 60 + 45);
  const expiration = normalizedString(ownedPosition?.expiration).slice(0, 10);
  const isWeekday = !['Sat', 'Sun'].includes(ny.weekday);
  const afterExpiration = /^\d{4}-\d{2}-\d{2}$/.test(expiration) && ny.date_key > expiration;

  if (settings.no_overnight_holding && afterExpiration) {
    return {
      reason: 'no_overnight_force_close',
      trigger_type: 'time',
      close_exit_phase: 'force',
      order_type: 'market',
      option_return_pct: managementUpdate.option_return_pct,
    };
  }
  if (settings.exit_before_regular_session_close && isWeekday && minutes >= forceMinutes) {
    return {
      reason: 'force_close_time_et',
      trigger_type: 'time',
      close_exit_phase: 'force',
      order_type: 'market',
      option_return_pct: managementUpdate.option_return_pct,
    };
  }

  const direction = normalizedString(ownedPosition?.direction).toLowerCase();
  const underlying = positiveNumber(underlyingPrice);
  const invalidation = positiveNumber(ownedPosition?.invalidation_price);
  const target = positiveNumber(ownedPosition?.target_price);
  const currentPrice = positiveNumber(quote?.sell_estimate_price ?? quote?.bid);
  const returnPct = managementUpdate.option_return_pct;
  if (underlying !== null && direction === 'bull') {
    if (settings.use_underlying_confirmation_bar_wick_invalidation && invalidation !== null && underlying <= invalidation) {
      return {
        reason: 'underlying_confirmation_bar_wick_proxy_invalidation',
        trigger_type: 'underlying_structure',
        order_type: 'limit',
        underlying_price_usd: underlying,
        trigger_price_usd: invalidation,
      };
    }
  }
  if (underlying !== null && direction === 'bear') {
    if (settings.use_underlying_confirmation_bar_wick_invalidation && invalidation !== null && underlying >= invalidation) {
      return {
        reason: 'underlying_confirmation_bar_wick_proxy_invalidation',
        trigger_type: 'underlying_structure',
        order_type: 'limit',
        underlying_price_usd: underlying,
        trigger_price_usd: invalidation,
      };
    }
  }

  if (settings.exit_before_regular_session_close && isWeekday && minutes >= closeMinutes) {
    return {
      reason: 'close_exit_time_et',
      trigger_type: 'time',
      close_exit_phase: 'normal',
      order_type: 'limit',
      option_return_pct: returnPct,
      trigger_price: currentPrice,
    };
  }

  // Full-position option risk controls take priority over a partial structural
  // target. A target touch must never leave a catastrophically losing or
  // already-protected remainder behind.
  if (
    settings.option_price_exit
    && returnPct !== null
    && returnPct <= -settings.catastrophic_stop_loss_pct
  ) {
    return {
      reason: `option_${String(settings.catastrophic_stop_loss_pct).replace('.', 'p')}pct_catastrophic_stop_loss`,
      trigger_type: 'price',
      close_exit_phase: null,
      order_type: 'limit',
      option_return_pct: returnPct,
      trigger_price: currentPrice,
    };
  }

  if (
    settings.option_price_exit
    && managementUpdate.breakeven_armed
    && returnPct !== null
    && returnPct <= (finiteNumber(managementUpdate.management_floor_pct) ?? settings.breakeven_floor_pct)
  ) {
    const effectiveFloorPct = finiteNumber(managementUpdate.management_floor_pct) ?? settings.breakeven_floor_pct;
    return {
      reason: 'option_breakeven_protect',
      trigger_type: 'price_management',
      close_exit_phase: null,
      order_type: 'limit',
      option_return_pct: returnPct,
      peak_option_return_pct: managementUpdate.peak_option_return_pct,
      breakeven_floor_pct: effectiveFloorPct,
      trigger_price: currentPrice,
    };
  }
  if (
    settings.option_price_exit
    && settings.option_take_profit_enabled
    && returnPct !== null
    && returnPct >= settings.take_profit_pct
  ) {
    return {
      reason: `option_${String(settings.take_profit_pct).replace('.', 'p')}pct_take_profit`,
      trigger_type: 'price',
      close_exit_phase: null,
      order_type: 'limit',
      option_return_pct: returnPct,
      trigger_price: currentPrice,
    };
  }
  if (underlying !== null && (direction === 'bull' || direction === 'bear')) {
    const targetTrigger = structuralTargetTrigger({
      ownedPosition,
      settings,
      managementUpdate,
      direction,
      underlying,
      target,
    });
    if (targetTrigger) return targetTrigger;
  }

  const setupTimeStop = setupTimeStopTrigger({
    ownedPosition,
    settings,
    managementUpdate,
    now,
    direction,
    underlying,
    target,
  });
  if (setupTimeStop) return setupTimeStop;
  return null;
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

export function buildZeroDteSimulatedExitPlan({
  owned_position: ownedPosition,
  option_snapshot: optionSnapshot,
  underlying_price_usd: underlyingPrice,
  config,
  now = new Date(),
} = {}) {
  assertZeroDteSimulationOnly(config);
  const ownership = ownershipGate(ownedPosition || {}, config);
  const settings = exitSettings(config);
  const quote = optionSnapshot
    ? buildOptionExecutionQuote(optionSnapshot, zeroDtePolicyQuoteConfig(config))
    : null;
  const managementUpdate = optionManagementUpdate(ownedPosition || {}, quote, settings);
  const trigger = exitTrigger({
    ownedPosition: ownedPosition || {},
    quote,
    settings,
    managementUpdate,
    now,
    underlyingPrice,
  });
  const effectiveManagementUpdate = partialTargetManagementUpdate(managementUpdate, settings, trigger);
  const reasons = [...ownership.reasons];
  const remainingQty = ownedQuantity(ownedPosition || {});
  let order = null;

  if (ownership.passed && trigger) {
    if (trigger.order_type === 'market') {
      order = {
        side: 'sell_to_close',
        order_type: 'market',
        code: normalizedString(ownedPosition.code),
        qty: Math.min(remainingQty, Math.max(1, Math.floor(nonnegativeNumber(trigger.requested_exit_qty, remainingQty)))),
        position_id: ownedPosition.position_id ?? null,
        remark: exitRemark(config, ownedPosition.plan_id),
      };
    } else {
      const exitTick = positiveNumber(quote?.tick);
      const sellPrice = positiveNumber(quote?.sell_estimate_price);
      if (exitTick === null) {
        reasons.push('missing_or_invalid_exit_price_tick');
      } else if (sellPrice === null) {
        reasons.push('missing_positive_exit_bid');
      } else {
        order = {
          side: 'sell_to_close',
          order_type: 'limit',
          code: normalizedString(ownedPosition.code),
          qty: Math.min(remainingQty, Math.max(1, Math.floor(nonnegativeNumber(trigger.requested_exit_qty, remainingQty)))),
          price: sellPrice,
          price_basis: quote?.sell_estimate_price ? 'bid_minus_slippage_buffer' : 'bid',
          position_id: ownedPosition.position_id ?? null,
          remark: exitRemark(config, ownedPosition.plan_id),
        };
      }
    }
  }

  const ready = ownership.passed && Boolean(trigger) && reasons.length === 0 && Boolean(order);
  return {
    schema_version: 1,
    planned_at: now.toISOString(),
    business_line: expectedBusinessLine(config),
    strategy: expectedStrategy(config),
    mode: 'simulate',
    source_plan_id: normalizedString(ownedPosition?.plan_id) || null,
    order_status: ready ? 'ready_for_simulation_exit' : (trigger ? 'exit_gate_failed' : 'watching'),
    gate: {
      passed: ready,
      ownership_passed: ownership.passed,
      reasons: [...new Set(reasons)],
    },
    owned_position: {
      code: normalizedString(ownedPosition?.code) || null,
      expiration: normalizedString(ownedPosition?.expiration).slice(0, 10) || null,
      filled_qty: nonnegativeNumber(ownedPosition?.filled_qty),
      exited_qty: nonnegativeNumber(ownedPosition?.exited_qty),
      pending_exit_qty: nonnegativeNumber(ownedPosition?.pending_exit_qty),
      line_owned_remaining_qty: remainingQty,
      entry_fill_price: positiveNumber(ownedPosition?.entry_fill_price),
      direction: normalizedString(ownedPosition?.direction).toLowerCase() || null,
      invalidation_price: positiveNumber(ownedPosition?.invalidation_price),
      target_price: positiveNumber(ownedPosition?.target_price),
      underlying_price_usd: positiveNumber(underlyingPrice),
      peak_option_return_pct: finiteNumber(ownedPosition?.peak_option_return_pct),
      breakeven_armed: booleanSetting(ownedPosition?.breakeven_armed, false),
      setup_type: normalizedString(ownedPosition?.setup_type ?? ownedPosition?.node_reaction).toLowerCase() || null,
      entry_at: normalizedString(
        ownedPosition?.entry_filled_at
          ?? ownedPosition?.entry_fill_at
          ?? ownedPosition?.entry_at
          ?? ownedPosition?.entry_submitted_at,
      ) || null,
      partial_target_taken: booleanSetting(ownedPosition?.partial_target_taken, false),
      management_floor_pct: finiteNumber(
        ownedPosition?.management_floor_pct
          ?? ownedPosition?.profit_floor_pct
          ?? ownedPosition?.breakeven_floor_pct,
      ),
    },
    quote: quote ? {
      quote_source: quote.quote_source || null,
      quote_received_at: quote.quote_received_at || null,
      bid_ask_source: quote.bid_ask_source || null,
      bid_ask_received_at: quote.bid_ask_received_at || null,
      bid: quote.bid ?? null,
      ask: quote.ask ?? null,
      sell_estimate_price: quote.sell_estimate_price ?? null,
      spread_abs: quote.spread_abs ?? null,
      spread_pct_of_mid: quote.spread_pct_of_mid ?? null,
    } : null,
    exit_rules: settings,
    management_update: effectiveManagementUpdate,
    trigger,
    order,
  };
}

// Builds a broker-safe, explicitly requested quantity exit while retaining the
// same ownership, quote-quality, slippage and simulation gates as normal JUNK
// exits. The experiment orchestrator uses this only after its virtual ledger
// has atomically reserved the requested contracts (for a triggered variant
// batch or for entry-fill remainder liquidation).
export function buildZeroDteSimulatedExplicitExitPlan({
  owned_position: ownedPosition,
  option_snapshot: optionSnapshot,
  requested_exit_qty: requestedExitQty,
  reason = 'explicit_line_owned_exit',
  trigger_type: triggerType = 'experiment_reconciliation',
  order_type: requestedOrderType = 'limit',
  allow_unpriced_market_force_close: allowUnpricedMarketForceClose = false,
  config,
  now = new Date(),
} = {}) {
  assertZeroDteSimulationOnly(config);
  const ownership = ownershipGate(ownedPosition || {}, config);
  const settings = exitSettings(config);
  const quote = optionSnapshot
    ? buildOptionExecutionQuote(optionSnapshot, zeroDtePolicyQuoteConfig(config))
    : null;
  const managementUpdate = optionManagementUpdate(ownedPosition || {}, quote, settings);
  const remainingQty = ownedQuantity(ownedPosition || {});
  const requestedQty = Math.max(0, Math.floor(nonnegativeNumber(requestedExitQty)));
  const exitQty = Math.min(remainingQty, requestedQty);
  const orderType = normalizedString(requestedOrderType).toLowerCase() === 'market' ? 'market' : 'limit';
  const emergencyUnpricedForceClose = allowUnpricedMarketForceClose === true
    && orderType === 'market'
    && normalizedString(reason) === 'experiment_unpriced_entry_force_close';
  const exitTick = positiveNumber(quote?.tick);
  const sellPrice = positiveNumber(quote?.sell_estimate_price);
  const reasons = ownership.reasons.filter((ownershipReason) => (
    emergencyUnpricedForceClose && ownershipReason === 'missing_entry_fill_price' ? false : true
  ));
  const ownershipPassed = reasons.length === 0;
  if (requestedQty < 1) reasons.push('missing_positive_explicit_exit_qty');
  if (orderType === 'limit' && exitTick === null) reasons.push('missing_or_invalid_exit_price_tick');
  if (orderType === 'limit' && sellPrice === null) reasons.push('missing_positive_exit_bid');
  const ready = ownershipPassed
    && exitQty > 0
    && (orderType === 'market' || sellPrice !== null)
    && reasons.length === 0;
  const trigger = {
    reason: normalizedString(reason) || 'explicit_line_owned_exit',
    trigger_type: normalizedString(triggerType) || 'experiment_reconciliation',
    order_type: orderType,
    requested_exit_qty: exitQty,
    option_return_pct: managementUpdate.option_return_pct,
  };
  return {
    schema_version: 1,
    planned_at: now.toISOString(),
    business_line: expectedBusinessLine(config),
    strategy: expectedStrategy(config),
    mode: 'simulate',
    source_plan_id: normalizedString(ownedPosition?.plan_id) || null,
    experiment_id: normalizedString(ownedPosition?.experiment_id) || null,
    cohort_id: normalizedString(ownedPosition?.cohort_id) || null,
    experiment_line_ids: Array.isArray(ownedPosition?.experiment_line_ids)
      ? [...new Set(ownedPosition.experiment_line_ids.map(normalizedString).filter(Boolean))]
      : [],
    emergency_unpriced_force_close: emergencyUnpricedForceClose,
    order_status: ready ? 'ready_for_simulation_exit' : 'exit_gate_failed',
    gate: {
      passed: ready,
      ownership_passed: ownershipPassed,
      reasons: [...new Set(reasons)],
    },
    owned_position: {
      code: normalizedString(ownedPosition?.code) || null,
      expiration: normalizedString(ownedPosition?.expiration).slice(0, 10) || null,
      filled_qty: nonnegativeNumber(ownedPosition?.filled_qty),
      exited_qty: nonnegativeNumber(ownedPosition?.exited_qty),
      pending_exit_qty: nonnegativeNumber(ownedPosition?.pending_exit_qty),
      line_owned_remaining_qty: remainingQty,
      entry_fill_price: positiveNumber(ownedPosition?.entry_fill_price),
      direction: normalizedString(ownedPosition?.direction).toLowerCase() || null,
      invalidation_price: positiveNumber(ownedPosition?.invalidation_price),
      target_price: positiveNumber(ownedPosition?.target_price),
    },
    quote: quote ? {
      quote_source: quote.quote_source || null,
      quote_received_at: quote.quote_received_at || null,
      bid_ask_source: quote.bid_ask_source || null,
      bid_ask_received_at: quote.bid_ask_received_at || null,
      bid: quote.bid ?? null,
      ask: quote.ask ?? null,
      sell_estimate_price: quote.sell_estimate_price ?? null,
      spread_abs: quote.spread_abs ?? null,
      spread_pct_of_mid: quote.spread_pct_of_mid ?? null,
    } : null,
    exit_rules: settings,
    management_update: managementUpdate,
    trigger,
    order: ready ? {
      side: 'sell_to_close',
      order_type: orderType,
      code: normalizedString(ownedPosition?.code),
      qty: exitQty,
      ...(orderType === 'limit' ? {
        price: sellPrice,
        price_basis: quote?.sell_estimate_price ? 'bid_minus_slippage_buffer' : 'bid',
      } : {}),
      position_id: ownedPosition?.position_id ?? null,
      remark: exitRemark(config, ownedPosition?.plan_id),
    } : null,
  };
}

function findBrokerPosition(positionResponse, code) {
  const positions = positionResponse?.s2c?.positionList || [];
  return positions.find((position) => normalizedString(position?.code) === normalizedString(code)) || null;
}

export async function executeZeroDteSimulatedExit({
  client,
  config,
  plan,
  now = new Date(),
  dependencies = {},
} = {}) {
  assertZeroDteSimulationOnly(config);
  if (!client) throw new Error('Moomoo client is required.');
  if (plan?.business_line !== expectedBusinessLine(config) || plan?.strategy !== expectedStrategy(config)) {
    throw new Error('Exit plan does not belong to the isolated junk GEX business line.');
  }
  if (plan?.mode !== 'simulate') throw new Error('Only simulated exit plans are accepted.');
  if (!plan?.gate?.passed || plan?.order_status !== 'ready_for_simulation_exit' || !plan?.order) {
    return {
      ...plan,
      order_status: 'not_submitted',
      execution: { submitted: false, reason: 'exit_plan_gate_not_passed' },
    };
  }

  const getAccounts = dependencies.fetch_accounts || fetchMoomooAccounts;
  const selectAccount = dependencies.select_simulated_option_account || selectSimulatedUsOptionAccount;
  const getPositions = dependencies.fetch_positions || fetchPositionList;
  const submitLimit = dependencies.place_limit_sell_order || placeLimitSellOrder;
  const submitMarket = dependencies.place_market_sell_order || placeMarketSellOrder;
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
      submission_phase: 'exit_account_preflight',
    },
  );
  const account = await runBrokerStage(
    () => selectAccount(accounts),
    {
      timeout_ms: preflightTimeoutMs,
      submission_outcome: 'not_submitted',
      submission_phase: 'exit_account_selection',
    },
  );
  if (!account || Number(account.trdEnv) !== TRD_ENV_SIMULATE) {
    throw classifiedSubmissionError(
      new Error('No simulated US options account found for isolated exit execution.'),
      'not_submitted',
      'exit_account_selection',
    );
  }
  const executionConfig = {
    ...config,
    trdEnv: TRD_ENV_SIMULATE,
    accId: String(account.accID || ''),
  };
  const positionResponse = await runBrokerStage(
    () => getPositions(client, executionConfig),
    {
      timeout_ms: preflightTimeoutMs,
      submission_outcome: 'not_submitted',
      submission_phase: 'exit_position_preflight',
    },
  );
  const brokerPosition = findBrokerPosition(positionResponse, plan.order.code);
  const brokerSellableQty = Math.floor(nonnegativeNumber(brokerPosition?.canSellQty, nonnegativeNumber(brokerPosition?.qty)));
  const lineOwnedQty = Math.floor(nonnegativeNumber(plan.owned_position?.line_owned_remaining_qty));
  const requestedQty = Math.floor(nonnegativeNumber(plan.order.qty));
  const exitQty = Math.min(requestedQty, lineOwnedQty, brokerSellableQty);
  if (exitQty < 1) {
    return {
      ...plan,
      order_status: 'not_submitted',
      execution: {
        submitted: false,
        reason: 'no_verified_sellable_line_owned_qty',
        line_owned_qty: lineOwnedQty,
        broker_sellable_qty: brokerSellableQty,
      },
    };
  }

  const order = {
    code: plan.order.code,
    qty: exitQty,
    remark: plan.order.remark,
    positionID: brokerPosition?.positionID ?? plan.order.position_id,
  };
  const response = await runBrokerStage(
    () => (plan.order.order_type === 'market'
      ? submitMarket(client, executionConfig, order)
      : submitLimit(client, executionConfig, { ...order, price: plan.order.price })),
    {
      timeout_ms: submitTimeoutMs,
      submission_outcome: 'unknown',
      submission_phase: 'exit_place_order',
    },
  );

  return {
    ...plan,
    order_status: 'submitted_simulation_exit',
    execution: {
      submitted: true,
      submitted_at: now.toISOString(),
      simulated_account_id: maskId(account.accID),
      submitted_qty: exitQty,
      line_owned_qty: lineOwnedQty,
      broker_sellable_qty: brokerSellableQty,
      broker_position_id: brokerPosition?.positionID ?? null,
      ...brokerExecutionSummary(normalizeForJson(response)),
    },
  };
}
