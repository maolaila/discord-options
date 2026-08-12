import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluate_junk_gex_strategy,
  normalize_gex_snapshot,
} from '../apps/zero-dte-options/junk-gex-strategy.mjs';

const now_iso = '2026-08-10T14:31:00.000Z';
const now_ms = Date.parse(now_iso);

function snapshot(overrides = {}) {
  return {
    ticker: 'SPX',
    snapshot_at: now_iso,
    session_date_et: '2026-08-10',
    state: 'fresh',
    spot_usd: 5004,
    total_gex_usd: -2_000_000,
    strikes: [
      {
        strike_usd: 4990,
        net_gex_usd: 1_000_000,
        call_gex_usd: 100_000,
        put_gex_usd: -8_000_000,
        node_type: 'put_wall',
      },
      {
        strike_usd: 5000,
        net_gex_usd: -5_000_000,
        call_gex_usd: 2_000_000,
        put_gex_usd: -3_000_000,
        node_type: 'major_negative',
      },
      {
        strike_usd: 5010,
        net_gex_usd: 4_000_000,
        call_gex_usd: 9_000_000,
        put_gex_usd: -500_000,
        node_type: 'call_wall',
      },
      {
        strike_usd: 5020,
        net_gex_usd: 500_000,
        call_gex_usd: 1_000_000,
        put_gex_usd: -200_000,
        node_type: 'secondary',
      },
    ],
    ...overrides,
  };
}

const bullish_bars = Object.freeze([
  {
    timestamp: '2026-08-10T14:15:00.000Z',
    open_usd: 4997,
    high_usd: 4999,
    low_usd: 4996,
    close_usd: 4998,
    volume: 1000,
  },
  {
    timestamp: '2026-08-10T14:20:00.000Z',
    open_usd: 4998,
    high_usd: 5004,
    low_usd: 4997,
    close_usd: 5003,
    volume: 1500,
  },
  {
    timestamp: '2026-08-10T14:25:00.000Z',
    open_usd: 5002,
    high_usd: 5005,
    low_usd: 5000.5,
    close_usd: 5004,
    volume: 1200,
  },
]);

const bearish_rejection_bars = Object.freeze([
  {
    timestamp: '2026-08-10T14:15:00.000Z',
    open_usd: 5005,
    high_usd: 5008,
    low_usd: 5004,
    close_usd: 5007,
    volume: 800,
  },
  {
    timestamp: '2026-08-10T14:20:00.000Z',
    open_usd: 5007,
    high_usd: 5011,
    low_usd: 5006,
    close_usd: 5008,
    volume: 1000,
  },
  {
    timestamp: '2026-08-10T14:25:00.000Z',
    open_usd: 5008,
    high_usd: 5008.5,
    low_usd: 5005,
    close_usd: 5006,
    volume: 1500,
  },
]);

const bearish_breakout_bars = Object.freeze([
  {
    timestamp: '2026-08-10T14:15:00.000Z',
    open_usd: 5003,
    high_usd: 5004,
    low_usd: 5001,
    close_usd: 5002,
    volume: 1000,
  },
  {
    timestamp: '2026-08-10T14:20:00.000Z',
    open_usd: 5002,
    high_usd: 5003,
    low_usd: 4996,
    close_usd: 4997,
    volume: 1500,
  },
  {
    timestamp: '2026-08-10T14:25:00.000Z',
    open_usd: 4998,
    high_usd: 4999.5,
    low_usd: 4995,
    close_usd: 4996,
    volume: 1200,
  },
]);

function stable_history({ transform, snapshot_overrides } = {}) {
  return [
    '2026-08-10T14:15:15.000Z',
    '2026-08-10T14:20:15.000Z',
    '2026-08-10T14:25:15.000Z',
  ].map((snapshot_at, index) => {
    const value = snapshot({ snapshot_at, ...(snapshot_overrides || {}) });
    return transform ? transform(value, index) : value;
  });
}

function bullish_context(overrides = {}) {
  return {
    last_price_usd: 5004,
    vwap_usd: 4999,
    bars_1m: bullish_bars,
    gex_node_history: stable_history(),
    ...overrides,
  };
}

function evaluate_bullish(overrides = {}) {
  return evaluate_junk_gex_strategy({
    gex_snapshot: snapshot(),
    now_ms,
    market_context: bullish_context(),
    ...overrides,
  });
}

test('normalization accepts a data envelope and keeps snake_case fields', () => {
  const normalized = normalize_gex_snapshot({ data: snapshot() });

  assert.equal(normalized.ticker, 'SPX');
  assert.equal(normalized.nodes.length, 4);
  assert.equal(normalized.nodes[0].strike_usd, 4990);
  assert.deepEqual(Object.keys(normalized.nodes[0]), [
    'strike_usd',
    'net_gex_usd',
    'call_gex_usd',
    'put_gex_usd',
    'node_type',
  ]);
});

test('node clipping retains two-sided primary/secondary structure and call/put walls', () => {
  const strikes = [
    { strike_usd: 4900, net_gex_usd: 10, call_gex_usd: 1, put_gex_usd: -500, node_type: 'put_wall' },
    { strike_usd: 4970, net_gex_usd: -100, call_gex_usd: 1, put_gex_usd: -10 },
    { strike_usd: 4980, net_gex_usd: -90, call_gex_usd: 1, put_gex_usd: -9 },
    { strike_usd: 4990, net_gex_usd: -1, call_gex_usd: 1, put_gex_usd: -1 },
    { strike_usd: 5010, net_gex_usd: 2, call_gex_usd: 2, put_gex_usd: -1 },
    { strike_usd: 5020, net_gex_usd: 80, call_gex_usd: 8, put_gex_usd: -1 },
    { strike_usd: 5030, net_gex_usd: 70, call_gex_usd: 7, put_gex_usd: -1 },
    { strike_usd: 5100, net_gex_usd: 5, call_gex_usd: 600, put_gex_usd: -1, node_type: 'call_wall' },
  ];
  const normalized = normalize_gex_snapshot(snapshot({ spot_usd: 5000, strikes }), 4);
  const selected = new Set(normalized.nodes.map((node) => node.strike_usd));

  for (const required of [4900, 4970, 4980, 5020, 5030, 5100]) {
    assert.ok(selected.has(required), `missing required structural node ${required}`);
  }
});

test('negative local gamma body break and retest yields a stable simulate-only call plan', () => {
  const result = evaluate_bullish();

  assert.equal(result.decision, 'trade');
  assert.equal(result.direction, 'bullish');
  assert.equal(result.signal_type, 'negative_gamma_expansion');
  assert.equal(result.regime, 'negative_gamma_expansion');
  assert.equal(result.local_gamma_node.strike_usd, 5000);
  assert.equal(result.option_selection.option_right, 'call');
  assert.equal(result.option_selection.strike_reference_usd, 5005);
  assert.equal(result.option_selection.strike_basis, 'max_call_gex_node_shifted_toward_spot');
  assert.equal(result.target_underlying_usd, 5010);
  assert.equal(result.gex_node_stability.matched_sample_count, 4);
  assert.equal(result.gex_node_stability.covered_bar_count, 3);
  assert.equal(result.gex_node_stability.preferred_bar_coverage_met, true);
  assert.match(result.signal_id, /^junk_gex_[a-f0-9]{20}$/);
  assert.match(result.setup_id, /^junk_gex_setup_[a-f0-9]{16}$/);
  assert.equal(result.setup_identity.confirmation_bar_at, '2026-08-10T14:25:00.000Z');
  assert.equal(result.execution_environment, 'simulate_only');
  assert.equal(result.real_trading_allowed, false);
  assert.equal(result.flow_dependency, 'none');
});

test('positive local gamma rejection yields a put plan using the strongest put-GEX wall', () => {
  const result = evaluate_junk_gex_strategy({
    gex_snapshot: snapshot({ spot_usd: 5005 }),
    now_ms,
    policy: { allow_positive_gamma_single_leg_mean_reversion: true },
    market_context: {
      last_price_usd: 5006,
      vwap_usd: 5007,
      bars_1m: bearish_rejection_bars,
      gex_node_history: stable_history({ snapshot_overrides: { spot_usd: 5005 } }),
    },
  });

  assert.equal(result.decision, 'trade');
  assert.equal(result.direction, 'bearish');
  assert.equal(result.signal_type, 'positive_gamma_mean_reversion');
  assert.equal(result.regime, 'positive_gamma_mean_reversion');
  assert.equal(result.local_gamma_node.strike_usd, 5010);
  assert.equal(result.option_selection.option_right, 'put');
  assert.equal(result.option_selection.strike_reference_usd, 4995);
  assert.equal(result.option_selection.strike_basis, 'max_put_gex_node_shifted_toward_spot');
  assert.equal(result.target_underlying_usd, 4990);
});

test('production defaults do not buy naked directional options inside a positive-Gamma pin', () => {
  const result = evaluate_junk_gex_strategy({
    gex_snapshot: snapshot({ spot_usd: 5005 }),
    now_ms,
    market_context: {
      last_price_usd: 5006,
      vwap_usd: 5007,
      bars_1m: bearish_rejection_bars,
      gex_node_history: stable_history({ snapshot_overrides: { spot_usd: 5005 } }),
    },
  });

  assert.equal(result.decision, 'no_trade');
  assert.deepEqual(result.reason_codes, ['positive_gamma_pin_requires_defined_risk_structure']);
});

test('bearish body-cross breakout and retest is supported symmetrically', () => {
  const result = evaluate_junk_gex_strategy({
    gex_snapshot: snapshot(),
    now_ms,
    market_context: {
      last_price_usd: 4996,
      vwap_usd: 4998,
      bars_1m: bearish_breakout_bars,
      gex_node_history: stable_history(),
    },
  });

  assert.equal(result.decision, 'trade');
  assert.equal(result.direction, 'bearish');
  assert.equal(result.tested_node.strike_usd, 5000);
  assert.equal(result.target_underlying_usd, 4990);
  assert.equal(result.option_selection.option_right, 'put');
});

test('signal identity remains stable when only the current GEX poll timestamp changes', () => {
  const first = evaluate_bullish();
  const second = evaluate_junk_gex_strategy({
    gex_snapshot: snapshot({ snapshot_at: '2026-08-10T14:31:15.000Z' }),
    now_ms: Date.parse('2026-08-10T14:31:15.000Z'),
    market_context: bullish_context(),
  });

  assert.equal(first.decision, 'trade');
  assert.equal(second.decision, 'trade');
  assert.equal(second.signal_id, first.signal_id);
  assert.equal(second.setup_id, first.setup_id);
});

test('a setup without three same-sign node-history samples fails closed', () => {
  const result = evaluate_bullish({
    market_context: bullish_context({
      gex_node_history: stable_history({
        transform: (value) => ({
          ...value,
          strikes: value.strikes.map((node) => (
            node.strike_usd === 5000 ? { ...node, net_gex_usd: Math.abs(node.net_gex_usd) } : node
          )),
        }),
      }),
    }),
  });

  assert.equal(result.decision, 'no_trade');
  assert.deepEqual(result.reason_codes, ['insufficient_stable_gex_node_history']);
});

test('current price must remain between stop and target and on the confirmed node side', () => {
  const invalidated = evaluate_bullish({
    market_context: bullish_context({ last_price_usd: 4998 }),
  });
  const reached = evaluate_bullish({
    market_context: bullish_context({ last_price_usd: 5010 }),
  });

  assert.equal(invalidated.decision, 'no_trade');
  assert.ok(invalidated.reason_codes.includes('setup_invalidated_before_execution'));
  assert.ok(invalidated.reason_codes.includes('current_price_lost_tested_node'));
  assert.equal(reached.decision, 'no_trade');
  assert.ok(reached.reason_codes.includes('target_reached_before_execution'));
});

test('entry drift beyond policy blocks an otherwise still-valid setup', () => {
  const result = evaluate_bullish({
    market_context: bullish_context({ last_price_usd: 5008 }),
  });

  assert.equal(result.decision, 'no_trade');
  assert.deepEqual(result.reason_codes, ['entry_drift_above_limit']);
});

test('bearish setups apply the same stop-target and drift checks', () => {
  const market_context = {
    last_price_usd: 5006,
    vwap_usd: 5007,
    bars_1m: bearish_rejection_bars,
    gex_node_history: stable_history({ snapshot_overrides: { spot_usd: 5005 } }),
  };
  const input = {
    gex_snapshot: snapshot({ spot_usd: 5005 }),
    now_ms,
    policy: { allow_positive_gamma_single_leg_mean_reversion: true },
  };
  const invalidated = evaluate_junk_gex_strategy({
    ...input,
    market_context: { ...market_context, last_price_usd: 5012 },
  });
  const reached = evaluate_junk_gex_strategy({
    ...input,
    market_context: { ...market_context, last_price_usd: 4990 },
  });
  const drifted = evaluate_junk_gex_strategy({
    ...input,
    market_context: { ...market_context, last_price_usd: 5002 },
  });

  assert.ok(invalidated.reason_codes.includes('setup_invalidated_before_execution'));
  assert.ok(invalidated.reason_codes.includes('current_price_lost_tested_node'));
  assert.ok(reached.reason_codes.includes('target_reached_before_execution'));
  assert.deepEqual(drifted.reason_codes, ['entry_drift_above_limit']);
});

test('a retest wick through the structural stop cannot trade', () => {
  const bars_1m = bullish_bars.map((bar, index) => (
    index === 2 ? { ...bar, low_usd: 4998.5 } : bar
  ));
  const result = evaluate_bullish({ market_context: bullish_context({ bars_1m }) });

  assert.equal(result.decision, 'no_trade');
  assert.deepEqual(result.reason_codes, ['waiting_for_node_confirmation']);
});

test('a breakout impulse that starts on the destination side is rejected', () => {
  const bars_1m = bullish_bars.map((bar, index) => (
    index === 1 ? { ...bar, open_usd: 5000.5 } : bar
  ));
  const result = evaluate_bullish({ market_context: bullish_context({ bars_1m }) });

  assert.equal(result.decision, 'no_trade');
  assert.deepEqual(result.reason_codes, ['waiting_for_node_confirmation']);
});

test('bearish retests also reject a crossed stop or an impulse from the wrong side', () => {
  const crossed_stop = bearish_breakout_bars.map((bar, index) => (
    index === 2 ? { ...bar, high_usd: 5001.5 } : bar
  ));
  const wrong_side = bearish_breakout_bars.map((bar, index) => (
    index === 1 ? { ...bar, open_usd: 4999.5 } : bar
  ));
  const market_context = {
    last_price_usd: 4996,
    vwap_usd: 4998,
    gex_node_history: stable_history(),
  };
  const crossed = evaluate_junk_gex_strategy({
    gex_snapshot: snapshot(),
    now_ms,
    market_context: { ...market_context, bars_1m: crossed_stop },
  });
  const wrong = evaluate_junk_gex_strategy({
    gex_snapshot: snapshot(),
    now_ms,
    market_context: { ...market_context, bars_1m: wrong_side },
  });

  assert.deepEqual(crossed.reason_codes, ['waiting_for_node_confirmation']);
  assert.deepEqual(wrong.reason_codes, ['waiting_for_node_confirmation']);
});

test('stale snapshots are blocked before any setup can trade', () => {
  const result = evaluate_bullish({
    gex_snapshot: snapshot({ snapshot_at: '2026-08-10T14:00:00.000Z' }),
  });

  assert.equal(result.decision, 'no_trade');
  assert.ok(result.reason_codes.includes('snapshot_stale'));
});

test('closed bars require valid fresh continuous timestamps in one ET session', () => {
  const missing_timestamp = evaluate_bullish({
    market_context: bullish_context({
      bars_1m: bullish_bars.map(({ timestamp: _timestamp, ...bar }) => bar),
    }),
  });
  const gap = evaluate_bullish({
    market_context: bullish_context({
      bars_1m: bullish_bars.map((bar, index) => (
        index === 1 ? { ...bar, timestamp: '2026-08-10T14:28:30.000Z' } : bar
      )),
    }),
  });
  const cross_session = evaluate_bullish({
    market_context: bullish_context({
      bars_1m: bullish_bars.map((bar) => ({
        ...bar,
        timestamp: bar.timestamp.replace('2026-08-10', '2026-08-09'),
      })),
    }),
  });
  const stale = evaluate_bullish({ now_ms: Date.parse('2026-08-10T14:34:00.000Z') });

  assert.ok(missing_timestamp.reason_codes.includes('invalid_closed_confirmation_bar'));
  assert.ok(gap.reason_codes.includes('closed_confirmation_bars_not_continuous'));
  assert.ok(cross_session.reason_codes.includes('closed_confirmation_bars_cross_et_session'));
  assert.ok(stale.reason_codes.includes('closed_confirmation_bars_stale'));
});

test('VWAP disagreement and absent node confirmation remain no-trade', () => {
  const result = evaluate_bullish({
    market_context: bullish_context({ vwap_usd: 5008 }),
  });

  assert.equal(result.decision, 'no_trade');
  assert.deepEqual(result.reason_codes, ['waiting_for_node_confirmation']);
});

test('missing VWAP fails closed instead of being coerced to zero', () => {
  const result = evaluate_bullish({
    market_context: bullish_context({ vwap_usd: null }),
  });

  assert.equal(result.decision, 'no_trade');
  assert.ok(result.reason_codes.includes('missing_vwap'));
});

test('five-minute acceptance requires usable volume and a non-weaker impulse', () => {
  const missing = evaluate_bullish({
    market_context: bullish_context({
      bars_1m: bullish_bars.map((bar, index) => (index === 1 ? { ...bar, volume: null } : bar)),
    }),
  });
  const weak = evaluate_bullish({
    market_context: bullish_context({
      bars_1m: bullish_bars.map((bar, index) => (index === 1 ? { ...bar, volume: 900 } : bar)),
    }),
  });

  assert.ok(missing.reason_codes.includes('missing_closed_bar_volume'));
  assert.deepEqual(weak.reason_codes, ['waiting_for_node_confirmation']);
});

test('Gamma Flip is retained as a first-class mechanism node even when max_nodes is small', () => {
  const normalized = normalize_gex_snapshot(snapshot({ gamma_flip_usd: 5005 }), 2);
  const flip = normalized.nodes.find((node) => node.strike_usd === 5005);

  assert.equal(normalized.gamma_flip_usd, 5005);
  assert.equal(flip?.node_type, 'gamma_flip');
  assert.equal(flip?.net_gex_usd, 0);
});

test('stable sample count cannot replace coverage across all three confirmation bars', () => {
  const clustered_history = [10, 20, 30].map((seconds) => snapshot({
    snapshot_at: `2026-08-10T14:15:${seconds}.000Z`,
  }));
  const result = evaluate_bullish({
    market_context: bullish_context({ gex_node_history: clustered_history }),
  });

  assert.equal(result.decision, 'no_trade');
  assert.deepEqual(result.reason_codes, ['gex_node_history_missing_confirmation_bar_coverage']);
});

test('directional long options are not chased into a positive-Gamma magnet center', () => {
  const strikes = [
    ...snapshot().strikes,
    { strike_usd: 5005, net_gex_usd: 20_000_000, call_gex_usd: 1_000_000, put_gex_usd: -100_000, node_type: 'magnet' },
  ];
  const result = evaluate_junk_gex_strategy({
    gex_snapshot: snapshot({ strikes }),
    now_ms,
    policy: { min_reward_risk_ratio: 0.1 },
    market_context: bullish_context({
      last_price_usd: 5004,
      gex_node_history: stable_history({ snapshot_overrides: { strikes } }),
    }),
  });

  assert.equal(result.decision, 'no_trade');
  assert.deepEqual(result.reason_codes, ['positive_gamma_magnet_center_no_chase']);
});

test('policy cannot opt the strategy into real trading', () => {
  assert.throws(
    () => evaluate_junk_gex_strategy({ policy: { real_trading_allowed: true } }),
    /restricted to simulate_only/,
  );
});
