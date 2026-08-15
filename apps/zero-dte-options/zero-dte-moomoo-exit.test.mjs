import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildZeroDteSimulatedExplicitExitPlan,
  buildZeroDteSimulatedExitPlan,
  executeZeroDteSimulatedExit,
} from './zero-dte-moomoo-exit.mjs';

function config(overrides = {}) {
  return {
    businessLine: 'zero-dte-options',
    policyExecutionEnvironment: 'simulate_only',
    policyRealTradingAllowed: false,
    trdEnv: 0,
    trdMarket: 2,
    optionExitTakeProfitPct: 25,
    policy: {
      business_line: { id: 'zero-dte-options' },
      execution: { environment: 'simulate_only', real_trading_allowed: false },
      execution_quality: {
        require_bid_ask: true,
        min_bid_price: 0.01,
        max_spread_pct_of_mid: 20,
        max_spread_abs: null,
        max_round_trip_loss_pct: 25,
        slippage_ticks: 1,
        slippage_pct_of_spread: 20,
        min_open_interest: 100,
        min_option_day_volume: 100,
      },
      exit_rules: {
        catastrophic_stop_loss_pct: 15,
        breakeven_activation_pct: 20,
        breakeven_floor_pct: 0,
        option_take_profit_enabled: false,
        option_take_profit_pct: 25,
        exit_before_regular_session_close: true,
        close_exit_start_time_et: '15:30',
        force_close_exit_start_time_et: '15:45',
        no_overnight_holding: true,
      },
    },
    ...overrides,
  };
}

function configWithFixedTakeProfit() {
  const resolved = config();
  resolved.policy.exit_rules.option_take_profit_enabled = true;
  return resolved;
}

function ownedPosition(overrides = {}) {
  return {
    business_line: 'zero-dte-options',
    strategy: 'junk_gex_nodes_v2',
    plan_id: 'zero_dte_1234567890abcdefabcd',
    code: 'SPXW260810C05005000',
    expiration: '2026-08-10',
    filled_qty: 3,
    exited_qty: 1,
    pending_exit_qty: 0,
    entry_fill_price: 5,
    ...overrides,
  };
}

function snapshot({ bid = 5, ask = 5.1 } = {}) {
  return {
    basic: {
      security: { market: 11, code: 'SPXW260810C05005000' },
      bidPrice: bid,
      askPrice: ask,
      bidVol: 10,
      askVol: 10,
      curPrice: (bid + ask) / 2,
      priceSpread: 0.05,
      volume: 500,
    },
    optionExData: { openInterest: 500, contractMultiplier: 100 },
    quote_source: 'push_order_book',
    quote_received_at: '2026-08-10T14:30:59.000Z',
  };
}

test('explicit experiment exit keeps simulation ownership gates and caps the requested line-owned quantity', () => {
  const plan = buildZeroDteSimulatedExplicitExitPlan({
    owned_position: ownedPosition({
      strategy: 'junk_gex_nodes_v3',
      filled_qty: 9,
      exited_qty: 2,
      experiment_id: 'junk_exit_grid_v1',
      cohort_id: 'junk_cohort_abc',
      experiment_line_ids: ['sl10_tp20', 'sl15_tp_off'],
    }),
    option_snapshot: snapshot({ bid: 4.8, ask: 4.9 }),
    requested_exit_qty: 3,
    reason: 'experiment_variant_exit_batch',
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(plan.gate.passed, true);
  assert.equal(plan.order_status, 'ready_for_simulation_exit');
  assert.equal(plan.order.qty, 3);
  assert.equal(plan.order.price, 4.75);
  assert.equal(plan.trigger.reason, 'experiment_variant_exit_batch');
  assert.equal(plan.experiment_id, 'junk_exit_grid_v1');
  assert.equal(plan.cohort_id, 'junk_cohort_abc');
  assert.deepEqual(plan.experiment_line_ids, ['sl10_tp20', 'sl15_tp_off']);

  const capped = buildZeroDteSimulatedExplicitExitPlan({
    owned_position: ownedPosition({ strategy: 'junk_gex_nodes_v3', filled_qty: 3, exited_qty: 1 }),
    option_snapshot: snapshot(),
    requested_exit_qty: 99,
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(capped.order.qty, 2);

  const forceMarket = buildZeroDteSimulatedExplicitExitPlan({
    owned_position: ownedPosition({ strategy: 'junk_gex_nodes_v3', filled_qty: 7, exited_qty: 0 }),
    option_snapshot: null,
    requested_exit_qty: 7,
    reason: 'force_close_time_et',
    order_type: 'market',
    config: config(),
    now: new Date('2026-08-10T19:45:00.000Z'),
  });
  assert.equal(forceMarket.gate.passed, true, 'force-close market exit must not depend on a bid quote');
  assert.equal(forceMarket.order.order_type, 'market');
  assert.equal(forceMarket.order.qty, 7);
  assert.equal(forceMarket.order.price, undefined);
});

test('fixed take profit is opt-in and catastrophic stop loss is the price safety net', () => {
  const disabledTakeProfit = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition(),
    option_snapshot: snapshot({ bid: 6.35, ask: 6.45 }),
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(disabledTakeProfit.trigger, null);
  assert.equal(disabledTakeProfit.order_status, 'watching');
  assert.equal(disabledTakeProfit.management_update.option_return_pct, 26);
  assert.equal(disabledTakeProfit.management_update.breakeven_armed, true);

  const take = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition(),
    option_snapshot: snapshot({ bid: 6.35, ask: 6.45 }),
    config: configWithFixedTakeProfit(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(take.gate.passed, true);
  assert.equal(take.trigger.reason, 'option_25pct_take_profit');
  assert.equal(take.trigger.option_return_pct, 26);
  assert.equal(take.order.order_type, 'limit');
  assert.equal(take.order.qty, 2);
  assert.equal(take.order.price, 6.3);

  const stop = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition(),
    option_snapshot: snapshot({ bid: 4.3, ask: 4.4 }),
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(stop.gate.passed, true);
  assert.equal(stop.trigger.reason, 'option_15pct_catastrophic_stop_loss');
  assert.equal(stop.trigger.option_return_pct, -15);
  assert.equal(stop.order.price, 4.25);
});

test('catastrophic protection defaults to 15 percent when no current or legacy override exists', () => {
  const defaults = config();
  delete defaults.policy.exit_rules.catastrophic_stop_loss_pct;
  const plan = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition(),
    option_snapshot: snapshot({ bid: 4.3, ask: 4.4 }),
    config: defaults,
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(plan.exit_rules.catastrophic_stop_loss_pct, 15);
  assert.equal(plan.trigger.reason, 'option_15pct_catastrophic_stop_loss');
});

test('20 percent peak arms breakeven and a later return to cost exits while preserving the peak', () => {
  const arm = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition(),
    option_snapshot: snapshot({ bid: 6.05, ask: 6.15 }),
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(arm.trigger, null);
  assert.deepEqual(arm.management_update, {
    option_return_pct: 20,
    peak_option_return_pct: 20,
    breakeven_armed: true,
  });

  const protect = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({
      peak_option_return_pct: arm.management_update.peak_option_return_pct,
      breakeven_armed: arm.management_update.breakeven_armed,
    }),
    option_snapshot: snapshot({ bid: 5.05, ask: 5.15 }),
    config: config(),
    now: new Date('2026-08-10T14:32:00.000Z'),
  });
  assert.equal(protect.gate.passed, true);
  assert.equal(protect.trigger.reason, 'option_breakeven_protect');
  assert.equal(protect.trigger.option_return_pct, 0);
  assert.equal(protect.trigger.peak_option_return_pct, 20);
  assert.equal(protect.order.price, 5);
  assert.deepEqual(protect.management_update, {
    option_return_pct: 0,
    peak_option_return_pct: 20,
    breakeven_armed: true,
  });
});

test('legacy option_stop_loss_pct remains a fallback for catastrophic protection', () => {
  const legacy = config();
  delete legacy.policy.exit_rules.catastrophic_stop_loss_pct;
  legacy.policy.exit_rules.option_stop_loss_pct = 18;
  const plan = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition(),
    option_snapshot: snapshot({ bid: 4.1, ask: 4.2 }),
    config: legacy,
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(plan.exit_rules.catastrophic_stop_loss_pct, 18);
  assert.equal(plan.trigger.reason, 'option_18pct_catastrophic_stop_loss');
});

test('15:30 ET creates a normal close limit and 15:45 ET creates a market force close', () => {
  const normal = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition(),
    option_snapshot: snapshot(),
    config: config(),
    now: new Date('2026-08-10T19:30:00.000Z'),
  });
  assert.equal(normal.trigger.reason, 'close_exit_time_et');
  assert.equal(normal.trigger.close_exit_phase, 'normal');
  assert.equal(normal.order.order_type, 'limit');

  const force = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition(),
    option_snapshot: null,
    config: config(),
    now: new Date('2026-08-10T19:45:00.000Z'),
  });
  assert.equal(force.gate.passed, true);
  assert.equal(force.trigger.reason, 'force_close_time_et');
  assert.equal(force.trigger.close_exit_phase, 'force');
  assert.equal(force.order.order_type, 'market');
  assert.equal(force.order.price, undefined);
});

test('underlying confirmation-wick proxy invalidation and next-node target can trigger before option PnL lines', () => {
  const invalidation = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({
      direction: 'bull',
      invalidation_price: 4999,
      target_price: 5010,
    }),
    option_snapshot: snapshot({ bid: 3.8, ask: 3.9 }),
    underlying_price_usd: 4998.5,
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(invalidation.gate.passed, true);
  assert.equal(invalidation.trigger.reason, 'underlying_confirmation_bar_wick_proxy_invalidation');
  assert.equal(invalidation.trigger.underlying_price_usd, 4998.5);

  const target = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({
      direction: 'bear',
      invalidation_price: 5011,
      target_price: 5000,
    }),
    option_snapshot: snapshot(),
    underlying_price_usd: 4999.5,
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(target.gate.passed, true);
  assert.equal(target.trigger.reason, 'underlying_next_gex_node_target');
  assert.equal(target.trigger.trigger_price_usd, 5000);
  assert.equal(target.trigger.structural_target_exit, 'partial');
  assert.equal(target.order.qty, 1);
  assert.equal(target.management_update.partial_target_taken, true);
  assert.equal(target.management_update.partial_target_taken_now, true);
  assert.equal(target.management_update.profit_floor_pct, 0);
});

test('a normal limit exit never fabricates a one-cent tick while force-close market exits remain available', () => {
  const base = snapshot({ bid: 4.8, ask: 4.9 });
  const missingTick = {
    ...base,
    basic: { ...base.basic, priceSpread: null },
  };
  const blockedLimit = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({ direction: 'bull', invalidation_price: 4999, target_price: 5010 }),
    option_snapshot: missingTick,
    underlying_price_usd: 4998.5,
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(blockedLimit.gate.passed, false);
  assert.equal(blockedLimit.order, null);
  assert.ok(blockedLimit.gate.reasons.includes('missing_or_invalid_exit_price_tick'));

  const forcedMarket = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition(),
    option_snapshot: missingTick,
    config: config(),
    now: new Date('2026-08-10T19:45:00.000Z'),
  });
  assert.equal(forcedMarket.gate.passed, true);
  assert.equal(forcedMarket.order.order_type, 'market');
});

test('a boundary mean-reversion setup exits after five minutes whenever the opposite boundary is missed', () => {
  const basePosition = ownedPosition({
    filled_qty: 1,
    exited_qty: 0,
    direction: 'bull',
    setup_type: 'range_mean_reversion',
    entry_at: '2026-08-10T14:25:00.000Z',
    target_price: 5010,
  });
  const timed = buildZeroDteSimulatedExitPlan({
    owned_position: basePosition,
    option_snapshot: snapshot({ bid: 5.05, ask: 5.15 }),
    underlying_price_usd: 5005,
    config: config(),
    now: new Date('2026-08-10T14:30:00.000Z'),
  });
  assert.equal(timed.gate.passed, true);
  assert.equal(timed.trigger.reason, 'setup_5m_time_stop_no_progress');
  assert.equal(timed.trigger.setup_type, 'range_mean_reversion');
  assert.equal(timed.trigger.elapsed_ms, 300_000);
  assert.equal(timed.trigger.option_return_pct, 0);
  assert.equal(timed.order.qty, 1);

  const early = buildZeroDteSimulatedExitPlan({
    owned_position: basePosition,
    option_snapshot: snapshot({ bid: 5.05, ask: 5.15 }),
    underlying_price_usd: 5005,
    config: config(),
    now: new Date('2026-08-10T14:29:59.000Z'),
  });
  assert.equal(early.trigger, null);

  const profitable = buildZeroDteSimulatedExitPlan({
    owned_position: basePosition,
    option_snapshot: snapshot({ bid: 5.1, ask: 5.2 }),
    underlying_price_usd: 5005,
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(profitable.management_update.option_return_pct, 1);
  assert.equal(profitable.trigger.reason, 'setup_5m_time_stop_no_progress');
  assert.equal(profitable.trigger.setup_type, 'range_mean_reversion');
});

test('the setup time stop stays scoped to boundary mean reversion and requires an opposite boundary target', () => {
  const common = {
    filled_qty: 1,
    exited_qty: 0,
    direction: 'bull',
    entry_at: '2026-08-10T14:20:00.000Z',
  };
  const breakout = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({ ...common, setup_type: 'breakout_retest', target_price: 5010 }),
    option_snapshot: snapshot({ bid: 5.05, ask: 5.15 }),
    underlying_price_usd: 5005,
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(breakout.trigger, null);

  const genericRejection = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({ ...common, setup_type: 'node_rejection', target_price: 5010 }),
    option_snapshot: snapshot({ bid: 5.05, ask: 5.15 }),
    underlying_price_usd: 5005,
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(genericRejection.trigger, null);

  const boundaryReversal = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({ ...common, setup_type: 'range_mean_reversion', target_price: 5010 }),
    option_snapshot: snapshot({ bid: 5.05, ask: 5.15 }),
    underlying_price_usd: 5005,
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(boundaryReversal.trigger.reason, 'setup_5m_time_stop_no_progress');
  assert.equal(boundaryReversal.trigger.setup_type, 'range_mean_reversion');

  const missingTarget = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({ ...common, setup_type: 'range_mean_reversion' }),
    option_snapshot: snapshot({ bid: 5.05, ask: 5.15 }),
    underlying_price_usd: 5005,
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(missingTarget.trigger, null);

  const switchedOff = config();
  switchedOff.policy.exit_rules.setup_time_stop_enabled = false;
  const disabled = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({ ...common, setup_type: 'range_mean_reversion', target_price: 5010 }),
    option_snapshot: snapshot({ bid: 5.05, ask: 5.15 }),
    underlying_price_usd: 5005,
    config: switchedOff,
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(disabled.trigger, null);
});

test('the first structural target partially exits multi-contract positions and a single contract exits fully', () => {
  const partial = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({
      filled_qty: 3,
      exited_qty: 0,
      direction: 'bull',
      target_price: 5010,
    }),
    option_snapshot: snapshot({ bid: 6.05, ask: 6.15 }),
    underlying_price_usd: 5011,
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(partial.trigger.structural_target_exit, 'partial');
  assert.equal(partial.trigger.requested_exit_qty, 2);
  assert.equal(partial.trigger.remaining_qty_after_requested_exit, 1);
  assert.equal(partial.order.qty, 2);
  assert.equal(partial.management_update.partial_target_taken, true);
  assert.equal(partial.management_update.breakeven_armed, true);
  assert.equal(partial.management_update.profit_floor_raised, true);

  const single = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({
      filled_qty: 1,
      exited_qty: 0,
      direction: 'bull',
      target_price: 5010,
    }),
    option_snapshot: snapshot({ bid: 6.05, ask: 6.15 }),
    underlying_price_usd: 5011,
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(single.trigger.structural_target_exit, 'full');
  assert.equal(single.order.qty, 1);
  assert.equal(single.management_update.partial_target_taken, undefined);
});

test('full option risk controls override a simultaneous partial structural target', () => {
  const catastrophic = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({
      filled_qty: 3,
      exited_qty: 0,
      direction: 'bull',
      target_price: 5010,
    }),
    option_snapshot: snapshot({ bid: 4, ask: 4.1 }),
    underlying_price_usd: 5011,
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(catastrophic.trigger.reason, 'option_15pct_catastrophic_stop_loss');
  assert.equal(catastrophic.order.qty, 3);
  assert.notEqual(catastrophic.trigger.structural_target_exit, 'partial');

  const breakeven = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({
      filled_qty: 3,
      exited_qty: 0,
      direction: 'bull',
      target_price: 5010,
      peak_option_return_pct: 25,
      breakeven_armed: true,
    }),
    option_snapshot: snapshot({ bid: 5, ask: 5.1 }),
    underlying_price_usd: 5011,
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(breakeven.trigger.reason, 'option_breakeven_protect');
  assert.equal(breakeven.order.qty, 3);
  assert.notEqual(breakeven.trigger.structural_target_exit, 'partial');
});

test('structural target partial sizing honors a policy ratio and its compatibility switch', () => {
  const ratioConfig = config();
  ratioConfig.policy.exit_rules.structural_target_partial_exit_ratio = 0.25;
  const ratioPlan = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({
      filled_qty: 4,
      exited_qty: 0,
      direction: 'bear',
      target_price: 4990,
    }),
    option_snapshot: snapshot({ bid: 6.05, ask: 6.15 }),
    underlying_price_usd: 4989,
    config: ratioConfig,
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(ratioPlan.trigger.structural_target_exit, 'partial');
  assert.equal(ratioPlan.order.qty, 1);

  const disabledConfig = config();
  disabledConfig.policy.exit_rules.structural_target_partial_exit_enabled = false;
  const fullPlan = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({
      filled_qty: 4,
      exited_qty: 0,
      direction: 'bear',
      target_price: 4990,
    }),
    option_snapshot: snapshot({ bid: 6.05, ask: 6.15 }),
    underlying_price_usd: 4989,
    config: disabledConfig,
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(fullPlan.trigger.structural_target_exit, 'full');
  assert.equal(fullPlan.order.qty, 4);
});

test('after a partial target the target does not repeat and the raised floor protects the remainder', () => {
  const afterPartial = ownedPosition({
    filled_qty: 3,
    exited_qty: 2,
    partial_target_taken: true,
    direction: 'bull',
    target_price: 5010,
  });
  const stillProfitable = buildZeroDteSimulatedExitPlan({
    owned_position: afterPartial,
    option_snapshot: snapshot({ bid: 5.1, ask: 5.2 }),
    underlying_price_usd: 5011,
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(stillProfitable.management_update.partial_target_taken, true);
  assert.equal(stillProfitable.trigger, null);

  const protect = buildZeroDteSimulatedExitPlan({
    owned_position: afterPartial,
    option_snapshot: snapshot({ bid: 5.05, ask: 5.15 }),
    underlying_price_usd: 5011,
    config: config(),
    now: new Date('2026-08-10T14:32:00.000Z'),
  });
  assert.equal(protect.trigger.reason, 'option_breakeven_protect');
  assert.equal(protect.trigger.breakeven_floor_pct, 0);
  assert.equal(protect.order.qty, 1);
});

test('normal close discipline has priority over option-price management', () => {
  const plan = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({ peak_option_return_pct: 20, breakeven_armed: true }),
    option_snapshot: snapshot({ bid: 3.8, ask: 3.9 }),
    config: config(),
    now: new Date('2026-08-10T19:30:00.000Z'),
  });
  assert.equal(plan.trigger.reason, 'close_exit_time_et');
  assert.equal(plan.trigger.close_exit_phase, 'normal');
});

test('the exit boundary refuses foreign ownership, exhausted quantity, and pending exits', () => {
  const legacyJunk = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({
      strategy: 'junk_gex_nodes_v1',
      direction: 'bull',
      invalidation_price: 4999,
    }),
    option_snapshot: snapshot(),
    underlying_price_usd: 4998.5,
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(legacyJunk.gate.ownership_passed, true);
  assert.equal(legacyJunk.strategy, 'junk_gex_nodes_v3');

  const foreign = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({ business_line: 'other-line' }),
    option_snapshot: snapshot({ bid: 6.35, ask: 6.45 }),
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(foreign.gate.passed, false);
  assert.ok(foreign.gate.reasons.includes('position_not_owned_by_zero_dte_line'));

  const exhausted = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({ exited_qty: 3, pending_exit_qty: 1, exit_order_id_ex: 'PENDING' }),
    option_snapshot: snapshot({ bid: 6.35, ask: 6.45 }),
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.ok(exhausted.gate.reasons.includes('no_line_owned_remaining_qty'));
  assert.ok(exhausted.gate.reasons.includes('line_exit_already_pending'));
  assert.equal(exhausted.order, null);
});

test('before any trigger the exit plan watches without broker submission', async () => {
  const watching = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition(),
    option_snapshot: snapshot(),
    config: config(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  assert.equal(watching.order_status, 'watching');
  assert.equal(watching.trigger, null);

  let brokerCalled = false;
  const result = await executeZeroDteSimulatedExit({
    client: {},
    config: config(),
    plan: watching,
    dependencies: {
      fetch_accounts: async () => { brokerCalled = true; return {}; },
    },
  });
  assert.equal(brokerCalled, false);
  assert.equal(result.order_status, 'not_submitted');
});

test('exit feature switches disable their corresponding triggers', () => {
  const disabled = config();
  disabled.policy.exit_rules = {
    ...disabled.policy.exit_rules,
    option_price_exit: false,
    use_underlying_confirmation_bar_wick_invalidation: false,
    use_next_gex_node_target: false,
    exit_before_regular_session_close: false,
  };
  const plan = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({
      direction: 'bull',
      invalidation_price: 4999,
      target_price: 5010,
    }),
    option_snapshot: snapshot({ bid: 7, ask: 7.1 }),
    underlying_price_usd: 5015,
    config: disabled,
    now: new Date('2026-08-10T19:50:00.000Z'),
  });
  assert.equal(plan.order_status, 'watching');
  assert.equal(plan.trigger, null);
});

test('exit execution caps sell quantity by both line ownership and broker sellable quantity', async () => {
  const plan = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition(),
    option_snapshot: snapshot({ bid: 6.35, ask: 6.45 }),
    config: configWithFixedTakeProfit(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  let captured = null;
  const result = await executeZeroDteSimulatedExit({
    client: {},
    config: configWithFixedTakeProfit(),
    plan,
    now: new Date('2026-08-10T14:31:01.000Z'),
    dependencies: {
      fetch_accounts: async () => ({}),
      select_simulated_option_account: () => ({ accID: '123456789', trdEnv: 0 }),
      fetch_positions: async () => ({
        s2c: {
          positionList: [{
            code: plan.order.code,
            qty: 9,
            canSellQty: 1,
            positionID: 'POSITION-1',
          }],
        },
      }),
      place_limit_sell_order: async (_client, executionConfig, order) => {
        captured = { executionConfig, order };
        return { retType: 0, s2c: { orderID: '100', orderIDEx: 'SIM-EXIT-100' } };
      },
    },
  });

  assert.equal(captured.executionConfig.trdEnv, 0);
  assert.equal(captured.order.qty, 1);
  assert.equal(captured.order.positionID, 'POSITION-1');
  assert.equal(captured.order.price, 6.3);
  assert.equal(result.order_status, 'submitted_simulation_exit');
  assert.equal(result.execution.submitted_qty, 1);
  assert.equal(result.execution.line_owned_qty, 2);
  assert.equal(result.execution.broker_sellable_qty, 1);
});

test('force-close execution uses a simulated market sell and never a limit call', async () => {
  const plan = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({ filled_qty: 1, exited_qty: 0 }),
    option_snapshot: null,
    config: config(),
    now: new Date('2026-08-10T19:45:00.000Z'),
  });
  let marketOrder = null;
  let limitCalled = false;
  const result = await executeZeroDteSimulatedExit({
    client: {},
    config: config(),
    plan,
    dependencies: {
      fetch_accounts: async () => ({}),
      select_simulated_option_account: () => ({ accID: '123456789', trdEnv: 0 }),
      fetch_positions: async () => ({
        s2c: { positionList: [{ code: plan.order.code, qty: 1, canSellQty: 1, positionID: 'POSITION-2' }] },
      }),
      place_limit_sell_order: async () => { limitCalled = true; return {}; },
      place_market_sell_order: async (_client, _executionConfig, order) => {
        marketOrder = order;
        return { retType: 0, s2c: { orderIDEx: 'SIM-FORCE-1' } };
      },
    },
  });

  assert.equal(limitCalled, false);
  assert.equal(marketOrder.qty, 1);
  assert.equal(marketOrder.price, undefined);
  assert.equal(result.execution.broker_order_id_ex, 'SIM-FORCE-1');
});

test('unpriced experiment force close permits only the explicit simulated market emergency path', async () => {
  const unpricedOwned = ownedPosition({
    strategy: 'junk_gex_nodes_v3',
    filled_qty: 14,
    exited_qty: 0,
    entry_fill_price: null,
    experiment_id: 'junk_exit_grid_v1',
    cohort_id: 'junk_cohort_unpriced',
    experiment_line_ids: ['control_sl15_tp_off'],
  });
  const refused = buildZeroDteSimulatedExplicitExitPlan({
    owned_position: unpricedOwned,
    requested_exit_qty: 14,
    reason: 'experiment_unpriced_entry_force_close',
    order_type: 'market',
    config: config(),
  });
  assert.equal(refused.gate.passed, false);
  assert.ok(refused.gate.reasons.includes('missing_entry_fill_price'));

  const emergency = buildZeroDteSimulatedExplicitExitPlan({
    owned_position: unpricedOwned,
    requested_exit_qty: 14,
    reason: 'experiment_unpriced_entry_force_close',
    order_type: 'market',
    allow_unpriced_market_force_close: true,
    config: config(),
  });
  assert.equal(emergency.gate.passed, true);
  assert.equal(emergency.emergency_unpriced_force_close, true);
  assert.equal(emergency.order.order_type, 'market');
  assert.equal(emergency.order.qty, 14);
  assert.equal(emergency.order.price, undefined);

  await assert.rejects(
    executeZeroDteSimulatedExit({
      client: {},
      config: config(),
      plan: emergency,
      dependencies: {
        fetch_accounts: async () => ({}),
        select_simulated_option_account: () => ({ accID: '123456789', trdEnv: 0 }),
        fetch_positions: async () => ({
          s2c: { positionList: [{ code: emergency.order.code, qty: 14, canSellQty: 14, positionID: 'POSITION-U' }] },
        }),
        place_market_sell_order: async () => new Promise(() => {}),
        submit_timeout_ms: 5,
      },
    }),
    (error) => error.submission_outcome === 'unknown'
      && error.submission_phase === 'exit_place_order',
  );
});

test('exit preflight failures are retryable without submission while PlaceOrder timeouts remain unknown', async () => {
  const plan = buildZeroDteSimulatedExitPlan({
    owned_position: ownedPosition({ filled_qty: 1, exited_qty: 0 }),
    option_snapshot: snapshot({ bid: 6.35, ask: 6.45 }),
    config: configWithFixedTakeProfit(),
    now: new Date('2026-08-10T14:31:00.000Z'),
  });
  await assert.rejects(
    executeZeroDteSimulatedExit({
      client: {},
      config: configWithFixedTakeProfit(),
      plan,
      dependencies: {
        fetch_accounts: async () => ({}),
        select_simulated_option_account: () => ({ accID: '123456789', trdEnv: 0 }),
        fetch_positions: async () => { throw new Error('positions temporarily unavailable'); },
      },
    }),
    (error) => error.submission_outcome === 'not_submitted'
      && error.submission_phase === 'exit_position_preflight',
  );

  await assert.rejects(
    executeZeroDteSimulatedExit({
      client: {},
      config: configWithFixedTakeProfit(),
      plan,
      dependencies: {
        fetch_accounts: async () => ({}),
        select_simulated_option_account: () => ({ accID: '123456789', trdEnv: 0 }),
        fetch_positions: async () => ({
          s2c: { positionList: [{ code: plan.order.code, qty: 1, canSellQty: 1, positionID: 'POSITION-3' }] },
        }),
        place_limit_sell_order: async () => new Promise(() => {}),
        submit_timeout_ms: 5,
      },
    }),
    (error) => error.submission_outcome === 'unknown'
      && error.submission_phase === 'exit_place_order',
  );

  await assert.rejects(
    executeZeroDteSimulatedExit({
      client: {},
      config: configWithFixedTakeProfit(),
      plan,
      dependencies: {
        fetch_accounts: async () => ({}),
        select_simulated_option_account: () => ({ accID: '123456789', trdEnv: 0 }),
        fetch_positions: async () => ({
          s2c: { positionList: [{ code: plan.order.code, qty: 1, canSellQty: 1, positionID: 'POSITION-4' }] },
        }),
        place_limit_sell_order: async () => {
          throw new Error('PlaceOrder failed: retType=-1 errCode=0 retMsg=broker rejected');
        },
      },
    }),
    (error) => error.submission_outcome === 'not_submitted'
      && error.submission_phase === 'exit_place_order',
  );
});
