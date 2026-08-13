import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildZeroDteSimulatedEntryPlan,
  executeZeroDteSimulatedEntry,
  prepareZeroDteSimulatedEntry,
} from './zero-dte-moomoo-executor.mjs';

const now = new Date('2026-08-10T14:31:00.000Z');

function config(overrides = {}) {
  const base = {
    businessLine: 'zero-dte-options',
    policyExecutionEnvironment: 'simulate_only',
    policyRealTradingAllowed: false,
    trdEnv: 0,
    trdMarket: 2,
    optionExitStopLossPct: 15,
    optionExitTakeProfitPct: 25,
    closeExitStartTimeEt: '15:30',
    forceCloseExitStartTimeEt: '15:45',
    policy: {
      business_line: { id: 'zero-dte-options' },
      execution: {
        environment: 'simulate_only',
        real_trading_allowed: false,
      },
      position_sizing: {
        paper_equity_usd: 10_000,
        target_position_pct: 5,
        min_position_pct: 1,
        max_position_pct: 10,
        contract_multiplier_default: 100,
      },
      execution_quality: {
        require_bid_ask: true,
        min_bid_price: 0.01,
        max_spread_pct_of_mid: 20,
        max_spread_abs: null,
        max_round_trip_loss_pct: 25,
        slippage_ticks: 1,
        slippage_pct_of_spread: 20,
        cap_qty_by_visible_ask: true,
        max_qty_to_ask_volume_ratio: 3,
        min_open_interest: 100,
        min_option_day_volume: 100,
      },
      exit_rules: {
        option_stop_loss_pct: 15,
        option_take_profit_pct: 25,
        exit_before_regular_session_close: true,
        close_exit_start_time_et: '15:30',
        force_close_exit_start_time_et: '15:45',
        no_overnight_holding: true,
      },
      risk_limits: {
        max_signal_age_seconds: 60,
        max_gex_snapshot_age_seconds: 600,
        max_open_positions: 1,
        max_trades_per_day: 3,
      },
    },
  };
  return { ...base, ...overrides };
}

function strategySignal(overrides = {}) {
  return {
    business_line: 'zero-dte-options',
    strategy: 'junk_gex_nodes_v3',
    decision: 'trade',
    action: 'open_long_option',
    flow_dependency: 'none',
    ticker: 'SPX',
    snapshot_at: '2026-08-10T14:30:50.000Z',
    snapshot_state: 'fresh',
    direction: 'bullish',
    signal_type: 'breakout_retest_acceleration',
    reason_codes: ['breakout_retest_acceleration', 'gex_node_confirmed', 'vwap_confirmed'],
    tested_node: { strike_usd: 5000, net_gex_usd: -5_000_000 },
    entry_reference_usd: 5004,
    stop_underlying_usd: 4999,
    target_underlying_usd: 5010,
    option_selection: {
      option_right: 'call',
      expiry_days: 0,
      strike_reference_usd: 5005,
      quote_and_liquidity_gate_required: true,
    },
    ...overrides,
  };
}

function contract(overrides = {}) {
  return {
    security: { market: 11, code: 'SPXW260810C05005000' },
    name: 'SPXW 2026-08-10 5005 Call',
    strikeTime: '2026-08-10',
    strikePrice: 5005,
    lotSize: 100,
    ...overrides,
  };
}

function optionSnapshot(overrides = {}) {
  return {
    basic: {
      security: { market: 11, code: 'SPXW260810C05005000' },
      bidPrice: 5,
      askPrice: 5.1,
      bidVol: 8,
      askVol: 5,
      curPrice: 5.05,
      priceSpread: 0.05,
      volume: 500,
    },
    optionExData: {
      openInterest: 500,
      contractMultiplier: 100,
    },
    quote_source: 'push_order_book',
    quote_received_at: '2026-08-10T14:30:59.000Z',
    bid_ask_source: 'push_order_book',
    bid_ask_received_at: '2026-08-10T14:30:59.000Z',
    ...overrides,
  };
}

test('strategy output maps directly to an isolated, idempotent simulation plan', () => {
  const plan = buildZeroDteSimulatedEntryPlan({
    signal: strategySignal(),
    contract: contract(),
    option_snapshot: optionSnapshot(),
    config: config(),
    now,
  });

  assert.equal(plan.business_line, 'zero-dte-options');
  assert.equal(plan.strategy, 'junk_gex_nodes_v3');
  assert.equal(plan.mode, 'simulate');
  assert.equal(plan.gate.passed, true);
  assert.equal(plan.order_status, 'ready_for_simulation');
  assert.match(plan.signal.signal_id, /^junk_gex_[a-f0-9]{20}$/);
  assert.equal(plan.signal.direction, 'bull');
  assert.equal(plan.signal.option_type, 'C');
  assert.equal(plan.signal.expiration, '2026-08-10');
  assert.equal(plan.signal.node_reaction, 'breakout_retest');
  assert.equal(plan.order.code, 'SPXW260810C05005000');
  assert.equal(plan.order.qty, 1);
  assert.equal(plan.order.price, 5.15);
  assert.equal(plan.provenance.discord_flow_used, false);

  const samePlan = buildZeroDteSimulatedEntryPlan({
    signal: strategySignal(),
    contract: contract(),
    option_snapshot: optionSnapshot(),
    config: config(),
    now,
  });
  assert.equal(samePlan.plan_id, plan.plan_id);
  assert.equal(samePlan.signal.signal_id, plan.signal.signal_id);
});

test('SPX zero-DTE entry rejects an AM-settled non-SPXW contract', () => {
  const plan = buildZeroDteSimulatedEntryPlan({
    signal: strategySignal(),
    contract: contract({
      security: { market: 11, code: 'SPX260810C05005000' },
      name: 'SPX AM-settled contract',
    }),
    option_snapshot: optionSnapshot({
      basic: {
        ...optionSnapshot().basic,
        security: { market: 11, code: 'SPX260810C05005000' },
      },
    }),
    config: config(),
    now,
  });
  assert.equal(plan.gate.passed, false);
  assert.ok(plan.gate.reasons.includes('spx_zero_dte_contract_must_be_spxw_pm_settled'));
});

test('stale GEX, duplicate signals, open-position cap, and Discord Flow dependency are hard gates', () => {
  const firstPlan = buildZeroDteSimulatedEntryPlan({
    signal: strategySignal(),
    contract: contract(),
    option_snapshot: optionSnapshot(),
    config: config(),
    now,
  });
  const blocked = buildZeroDteSimulatedEntryPlan({
    signal: strategySignal({
      snapshot_at: '2026-08-10T14:00:00.000Z',
      discord_flow_dependency: true,
      signal_id: firstPlan.signal.signal_id,
    }),
    contract: contract(),
    option_snapshot: optionSnapshot(),
    config: config(),
    risk_state: {
      executed_signal_ids: [firstPlan.signal.signal_id],
      open_position_count: 1,
    },
    now,
  });

  assert.equal(blocked.gate.passed, false);
  assert.equal(blocked.order, null);
  assert.ok(blocked.gate.reasons.some((reason) => reason.startsWith('signal_stale:')));
  assert.ok(blocked.gate.reasons.some((reason) => reason.startsWith('gex_snapshot_stale:')));
  assert.ok(blocked.gate.reasons.includes('duplicate_signal_id'));
  assert.ok(blocked.gate.reasons.includes('discord_flow_dependency_forbidden'));
  assert.ok(blocked.gate.reasons.includes('max_open_positions_reached:1'));
});

test('executor independently enforces the inclusive ten-minute fixed-sample boundary', () => {
  const at = (snapshot_at) => buildZeroDteSimulatedEntryPlan({
    signal: strategySignal({ snapshot_at }),
    contract: contract(),
    option_snapshot: optionSnapshot(),
    config: config(),
    now,
  });
  const boundary = at('2026-08-10T14:21:00.000Z');
  const exceeded = at('2026-08-10T14:20:59.999Z');

  assert.ok(!boundary.gate.reasons.some((reason) => reason.startsWith('gex_snapshot_stale:')));
  assert.ok(exceeded.gate.reasons.some((reason) => reason.startsWith('gex_snapshot_stale:600001')));
});

test('entry window, cooldown, daily loss, contract identity, and non-none Flow source are hard gates', () => {
  const restrictedConfig = config();
  restrictedConfig.policy.strategy = {
    entry_start_time_et: '09:35',
    entry_cutoff_time_et: '15:20',
    cooldown_seconds: 900,
  };
  restrictedConfig.policy.risk_limits.max_daily_realized_loss_usd = 300;
  const blocked = buildZeroDteSimulatedEntryPlan({
    signal: strategySignal({ flow_dependency: 'discord_flow' }),
    contract: contract({ strikePrice: 5010, strikeTime: '2026-08-11' }),
    option_snapshot: optionSnapshot(),
    config: restrictedConfig,
    risk_state: {
      daily_realized_pnl_usd: -300,
      last_entry_at: '2026-08-10T14:25:00.000Z',
    },
    now,
  });

  assert.equal(blocked.gate.passed, false);
  assert.ok(blocked.gate.reasons.includes('discord_flow_dependency_forbidden'));
  assert.ok(blocked.gate.reasons.includes('max_daily_realized_loss_reached:-300'));
  assert.ok(blocked.gate.reasons.includes('entry_cooldown_active:360000'));
  assert.ok(blocked.gate.reasons.includes('contract_expiration_mismatch:2026-08-11'));
  assert.ok(blocked.gate.reasons.includes('contract_strike_mismatch:5010'));

  const tooLate = buildZeroDteSimulatedEntryPlan({
    signal: strategySignal({
      snapshot_at: '2026-08-10T19:21:00.000Z',
      generated_at: '2026-08-10T19:21:00.000Z',
      gex_snapshot_at: '2026-08-10T19:21:00.000Z',
    }),
    contract: contract(),
    option_snapshot: optionSnapshot({
      quote_received_at: '2026-08-10T19:21:00.000Z',
      bid_ask_received_at: '2026-08-10T19:21:00.000Z',
    }),
    config: restrictedConfig,
    now: new Date('2026-08-10T19:21:00.000Z'),
  });
  assert.ok(tooLate.gate.reasons.includes('after_entry_cutoff_time_et'));
});

test('quote quality gates block an untradeable option before submission', () => {
  const blocked = buildZeroDteSimulatedEntryPlan({
    signal: strategySignal(),
    contract: contract(),
    option_snapshot: optionSnapshot({
      basic: {
        security: { market: 11, code: 'SPXW260810C05005000' },
        bidPrice: 10,
        askPrice: 15,
        bidVol: 1,
        askVol: 1,
        curPrice: 12,
        priceSpread: 0.05,
        volume: 1,
      },
      optionExData: { openInterest: 1, contractMultiplier: 100 },
    }),
    config: config(),
    now,
  });

  assert.equal(blocked.gate.passed, false);
  assert.ok(blocked.gate.reasons.some((reason) => reason.includes('spread_pct_above_gate')));
  assert.ok(blocked.gate.reasons.some((reason) => reason.includes('option_day_volume_below_min')));
  assert.ok(blocked.gate.reasons.some((reason) => reason.includes('open_interest_below_min')));
});

test('10% sizing is a soft target and $10.30/$10.50 contracts fall back to one unit per $10k line', () => {
  for (const buyLimitPrice of [10.30, 10.50]) {
    const highPremium = buildZeroDteSimulatedEntryPlan({
      signal: strategySignal(),
      contract: contract(),
      option_snapshot: optionSnapshot({
        basic: {
          ...optionSnapshot().basic,
          bidPrice: buyLimitPrice - 0.01,
          askPrice: buyLimitPrice - 0.01,
          bidVol: 8,
          askVol: 3,
          curPrice: buyLimitPrice - 0.01,
          priceSpread: 0.01,
        },
      }),
      config: config(),
      now,
    });

    assert.equal(highPremium.gate.passed, true);
    assert.equal(highPremium.quote.buy_limit_price, buyLimitPrice);
    assert.equal(highPremium.position_sizing.qty, 1);
    assert.equal(highPremium.position_sizing.contract_cost_usd, buyLimitPrice * 100);
    assert.equal(highPremium.position_sizing.estimated_position_pct, buyLimitPrice);
    assert.equal(highPremium.position_sizing.max_position_is_soft_target, true);
    assert.ok(highPremium.position_sizing.estimated_position_pct > 10);
    assert.ok(highPremium.position_sizing.reasons.includes('minimum_contract_above_max_position_target'));
  }
});

test('one contract above the full $10k paper line still fails closed', () => {
  const blocked = buildZeroDteSimulatedEntryPlan({
    signal: strategySignal(),
    contract: contract(),
    option_snapshot: optionSnapshot({
      basic: {
        ...optionSnapshot().basic,
        bidPrice: 100,
        askPrice: 100.01,
        bidVol: 8,
        askVol: 10,
        curPrice: 100,
        priceSpread: 0.01,
      },
    }),
    config: config(),
    now,
  });

  assert.equal(blocked.gate.passed, false);
  assert.equal(blocked.position_sizing.qty, 0);
  assert.ok(blocked.gate.reasons.includes('position_sizing:contract_cost_above_paper_equity'));
});

test('JUNK execution can require OI and day-volume fields instead of treating missing data as liquid', () => {
  const strict = config();
  strict.policy.execution_quality.require_open_interest_and_volume = true;
  const blocked = buildZeroDteSimulatedEntryPlan({
    signal: strategySignal(),
    contract: contract(),
    option_snapshot: optionSnapshot({
      basic: {
        security: { market: 11, code: 'SPXW260810C05005000' },
        bidPrice: 5,
        askPrice: 5.1,
        bidVol: 8,
        askVol: 5,
        curPrice: 5.05,
        priceSpread: 0.05,
      },
      optionExData: { contractMultiplier: 100 },
    }),
    config: strict,
    now,
  });

  assert.equal(blocked.gate.passed, false);
  assert.ok(blocked.gate.reasons.some((reason) => reason.endsWith('missing_option_day_volume')));
  assert.ok(blocked.gate.reasons.some((reason) => reason.endsWith('missing_open_interest')));
});

test('real or ambiguously permissive policy configurations are rejected before broker access', () => {
  assert.throws(
    () => buildZeroDteSimulatedEntryPlan({
      signal: strategySignal(),
      contract: contract(),
      option_snapshot: optionSnapshot(),
      config: config({ trdEnv: 1 }),
      now,
    }),
    /rejects every non-simulated trading environment/,
  );
  assert.throws(
    () => buildZeroDteSimulatedEntryPlan({
      signal: strategySignal(),
      contract: contract(),
      option_snapshot: optionSnapshot(),
      config: config({ policyRealTradingAllowed: true }),
      now,
    }),
    /real_trading_allowed=false/,
  );
});

test('prepare resolves a moomoo contract and closes a one-shot quote feed', async () => {
  let closed = false;
  const plan = await prepareZeroDteSimulatedEntry({
    client: {},
    signal: strategySignal(),
    config: config(),
    now,
    dependencies: {
      find_option_contract: async () => ({ found: true, contract: contract(), candidateCount: 25 }),
      create_quote_feed: () => ({
        getSnapshots: async () => ({ snapshots: [optionSnapshot()] }),
        close: async () => { closed = true; },
      }),
    },
  });

  assert.equal(plan.gate.passed, true);
  assert.equal(closed, true);
});

test('prepare selects the unique PM-settled SPXW contract when the generic finder returns SPX first', async () => {
  const spxw = contract();
  const plan = await prepareZeroDteSimulatedEntry({
    client: {},
    signal: strategySignal(),
    config: config(),
    now,
    quote_feed: {
      getSnapshots: async (securities) => {
        assert.equal(securities[0].code, spxw.security.code);
        return { snapshots: [optionSnapshot()] };
      },
    },
    dependencies: {
      find_option_contract: async () => ({
        found: true,
        contract: contract({
          security: { market: 11, code: 'SPX260810C05005000' },
          name: 'SPX AM-settled',
        }),
        response: {
          s2c: {
            optionChain: [{
              strikeTime: '2026-08-10',
              option: [{
                call: {
                  basic: {
                    security: spxw.security,
                    name: spxw.name,
                    lotSize: spxw.lotSize,
                  },
                  optionExData: {
                    strikeTime: spxw.strikeTime,
                    strikePrice: spxw.strikePrice,
                    type: 1,
                  },
                },
              }],
            }],
          },
        },
      }),
    },
  });
  assert.equal(plan.gate.passed, true);
  assert.equal(plan.contract.code, 'SPXW260810C05005000');
});

test('execute submits only a passed plan to a selected simulated options account', async () => {
  const plan = buildZeroDteSimulatedEntryPlan({
    signal: strategySignal(),
    contract: contract(),
    option_snapshot: optionSnapshot(),
    config: config(),
    now,
  });
  let capturedConfig = null;
  let capturedOrder = null;
  const result = await executeZeroDteSimulatedEntry({
    client: {},
    config: config(),
    plan,
    now,
    dependencies: {
      fetch_accounts: async () => ({ s2c: { accList: [] } }),
      select_simulated_option_account: () => ({
        accID: '123456789',
        trdEnv: 0,
        trdMarketAuthList: [2],
        simAccType: 2,
      }),
      place_limit_buy_order: async (_client, executionConfig, order) => {
        capturedConfig = executionConfig;
        capturedOrder = order;
        return { retType: 0, s2c: { orderID: '98765', orderIDEx: 'SIM-98765' } };
      },
    },
  });

  assert.equal(capturedConfig.trdEnv, 0);
  assert.equal(capturedConfig.accId, '123456789');
  assert.deepEqual(capturedOrder, {
    code: 'SPXW260810C05005000',
    qty: 1,
    price: 5.15,
    remark: plan.order.remark,
  });
  assert.equal(result.order_status, 'submitted_simulation');
  assert.equal(result.execution.submitted, true);
  assert.equal(result.execution.simulated_account_id, '*****6789');
  assert.equal(result.execution.broker_order_id, '98765');
  assert.equal(result.execution.broker_order_id_ex, 'SIM-98765');
});

test('execute returns without broker access when the plan gate failed', async () => {
  const blockedPlan = buildZeroDteSimulatedEntryPlan({
    signal: strategySignal({ decision: 'no_trade', action: 'hold' }),
    contract: contract(),
    option_snapshot: optionSnapshot(),
    config: config(),
    now,
  });
  let brokerCalled = false;
  const result = await executeZeroDteSimulatedEntry({
    client: {},
    config: config(),
    plan: blockedPlan,
    dependencies: {
      fetch_accounts: async () => { brokerCalled = true; return {}; },
    },
  });

  assert.equal(brokerCalled, false);
  assert.equal(result.order_status, 'not_submitted');
  assert.equal(result.execution.submitted, false);
});

test('execute revalidates plan TTL and immutable order fields before broker access', async () => {
  const plan = buildZeroDteSimulatedEntryPlan({
    signal: strategySignal(),
    contract: contract(),
    option_snapshot: optionSnapshot(),
    config: config(),
    now,
  });
  const tampered = {
    ...plan,
    order: { ...plan.order, qty: plan.order.qty + 1 },
  };
  let brokerCalled = false;
  const result = await executeZeroDteSimulatedEntry({
    client: {},
    config: config(),
    plan: tampered,
    now: new Date('2026-08-10T14:32:00.000Z'),
    dependencies: {
      fetch_accounts: async () => { brokerCalled = true; return {}; },
    },
  });

  assert.equal(brokerCalled, false);
  assert.equal(result.order_status, 'not_submitted');
  assert.equal(result.execution.reason, 'execution_revalidation_failed');
  assert.ok(result.execution.reasons.includes('entry_plan_expired:60000'));
  assert.ok(result.execution.reasons.includes('order_qty_mismatch'));
});

test('entry preflight failures are definitely not submitted while PlaceOrder timeouts stay unknown', async () => {
  const plan = buildZeroDteSimulatedEntryPlan({
    signal: strategySignal(),
    contract: contract(),
    option_snapshot: optionSnapshot(),
    config: config(),
    now,
  });
  await assert.rejects(
    executeZeroDteSimulatedEntry({
      client: {},
      config: config(),
      plan,
      now,
      dependencies: {
        fetch_accounts: async () => { throw new Error('accounts temporarily unavailable'); },
      },
    }),
    (error) => error.submission_outcome === 'not_submitted'
      && error.submission_phase === 'entry_account_preflight',
  );

  await assert.rejects(
    executeZeroDteSimulatedEntry({
      client: {},
      config: config(),
      plan,
      now,
      dependencies: {
        fetch_accounts: async () => ({}),
        select_simulated_option_account: () => ({ accID: '123456789', trdEnv: 0 }),
        place_limit_buy_order: async () => new Promise(() => {}),
        submit_timeout_ms: 5,
      },
    }),
    (error) => error.submission_outcome === 'unknown'
      && error.submission_phase === 'entry_place_order',
  );

  await assert.rejects(
    executeZeroDteSimulatedEntry({
      client: {},
      config: config(),
      plan,
      now,
      dependencies: {
        fetch_accounts: async () => ({}),
        select_simulated_option_account: () => ({ accID: '123456789', trdEnv: 0 }),
        place_limit_buy_order: async () => {
          throw new Error('PlaceOrder failed: retType=-1 errCode=0 retMsg=broker rejected');
        },
      },
    }),
    (error) => error.submission_outcome === 'not_submitted'
      && error.submission_phase === 'entry_place_order',
  );
});
