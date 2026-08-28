import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_JUNK_GEX_POLICY,
  directional_option_gex_reference,
  evaluate_junk_gex_strategy,
  normalize_gex_snapshot,
} from '../apps/zero-dte-options/junk-gex-strategy.mjs';

const now_iso = '2026-08-10T14:31:00.000Z';
const now_ms = Date.parse(now_iso);
const active_policy = JSON.parse(readFileSync(
  new URL('../config/zero-dte-options-policy.json', import.meta.url),
  'utf8',
));

function snapshot(overrides = {}) {
  return {
    ticker: 'SPX',
    snapshot_at: now_iso,
    session_date_et: '2026-08-10',
    state: 'fresh',
    spot_usd: 5004,
    summary: {
      total_gex_usd: -2_000_000,
      king_strike_usd: 5000,
      major_positive_strike_usd: 5010,
      major_negative_strike_usd: 5000,
      gamma_flip_usd: null,
      call_wall_strike_usd: 5010,
      put_wall_strike_usd: 4990,
    },
    strikes: [
      {
        strike_usd: 4990,
        net_gex_usd: 1_000_000,
        node_type: 'put_wall',
      },
      {
        strike_usd: 5000,
        net_gex_usd: -5_000_000,
        node_type: 'major_negative',
      },
      {
        strike_usd: 5010,
        net_gex_usd: 4_000_000,
        node_type: 'call_wall',
      },
      {
        strike_usd: 5020,
        net_gex_usd: 500_000,
        node_type: 'secondary',
      },
    ],
    ...overrides,
  };
}

function option_chain(overrides = {}) {
  return {
    data: {
      ticker: 'SPX',
      expiration: '2026-08-10',
      snapshot_at: now_iso,
      greeks_as_of: now_iso,
      open_interest_as_of: '2026-08-10T12:00:00.000Z',
      underlying_price_usd: 5004,
      contracts: [
        { contract_symbol: 'SPXW260810C05000000', expiration: '2026-08-10', strike_usd: 5000, right: 'C', gamma: 0.02, open_interest: 100 },
        { contract_symbol: 'SPXW260810C05010000', expiration: '2026-08-10', strike_usd: 5010, right: 'C', gamma: 0.03, open_interest: 1_000 },
        { contract_symbol: 'SPXW260810P04990000', expiration: '2026-08-10', strike_usd: 4990, right: 'P', gamma: 0.04, open_interest: 1_000 },
        { contract_symbol: 'SPXW260810P05000000', expiration: '2026-08-10', strike_usd: 5000, right: 'P', gamma: 0.02, open_interest: 100 },
        { contract_symbol: 'SPX260810P04980000', expiration: '2026-08-10', strike_usd: 4980, right: 'P', gamma: 1, open_interest: 1_000_000 },
      ],
      ...overrides,
    },
    _meta: { data_freshness_seconds: 1, truncated: false },
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
    low_usd: 5000,
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
    high_usd: 5011,
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
    high_usd: 5000,
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
    option_chain_snapshot: option_chain(),
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
    'node_type',
    'rank',
    'relative_strength',
  ]);
  assert.equal(normalized.call_wall_usd, 5010);
  assert.equal(normalized.put_wall_usd, 4990);
});

test('directional option reference ranks the official chain schema by gamma times open interest', () => {
  const call = directional_option_gex_reference({
    option_chain_snapshot: option_chain(),
    direction: 'bullish',
    expiration: '2026-08-10',
  });
  const put = directional_option_gex_reference({
    option_chain_snapshot: option_chain(),
    direction: 'bearish',
    expiration: '2026-08-10',
  });

  assert.equal(call.strike_usd, 5010);
  assert.equal(call.gamma_oi_weight, 30);
  assert.equal(call.contract_root, 'SPXW');
  assert.equal(call.source_field, 'data.contracts[].gamma*open_interest');
  assert.equal(put.strike_usd, 4990);
  assert.equal(put.gamma_oi_weight, 40);
});

test('directional option reference supports a Nightwatch-covered non-SPX OSI root', () => {
  const response = option_chain({
    ticker: 'QQQ',
    underlying_price_usd: 710,
    contracts: [
      { contract_symbol: 'QQQ260810C00710000', expiration: '2026-08-10', strike_usd: 710, right: 'C', gamma: 0.04, open_interest: 1_000 },
      { contract_symbol: 'QQQ260810C00715000', expiration: '2026-08-10', strike_usd: 715, right: 'C', gamma: 0.02, open_interest: 500 },
    ],
  });
  const selected = directional_option_gex_reference({
    option_chain_snapshot: response,
    ticker: 'QQQ',
    direction: 'bullish',
    expiration: '2026-08-10',
  });
  assert.equal(selected?.contract_root, 'QQQ');
  assert.equal(selected?.strike_usd, 710);
});

test('directional option reference rejects contract symbols that contradict their row fields', () => {
  const forged = option_chain({
    contracts: [
      { contract_symbol: 'SPXW260811P06000000', expiration: '2026-08-10', strike_usd: 5010, right: 'C', gamma: 100, open_interest: 100_000 },
      ...option_chain().data.contracts,
    ],
  });
  const call = directional_option_gex_reference({
    option_chain_snapshot: forged,
    direction: 'bullish',
    expiration: '2026-08-10',
  });

  assert.equal(call.strike_usd, 5010);
  assert.equal(call.gamma_oi_weight, 30);
});

test('stale or provider-truncated option chains cannot choose a directional strike', () => {
  const stale = evaluate_bullish({
    option_chain_snapshot: option_chain({ snapshot_at: '2026-08-10T14:00:00.000Z' }),
  });
  const truncated_chain = option_chain();
  truncated_chain._meta.truncated = true;
  const truncated = evaluate_bullish({ option_chain_snapshot: truncated_chain });

  assert.deepEqual(stale.reason_codes, ['missing_call_directional_gex_reference']);
  assert.deepEqual(truncated.reason_codes, ['missing_call_directional_gex_reference']);
});

test('directional option reference rejects wrong identity, incomplete provenance, stale Greeks, and invalid signed Gamma', () => {
  const wrong_ticker = option_chain({ ticker: 'SPY' });
  const missing_expiration = option_chain({ expiration: null });
  const stale_greeks = option_chain({ greeks_as_of: '2026-08-10T14:00:00.000Z' });
  const missing_oi_as_of = option_chain({ open_interest_as_of: null });
  const future_oi_as_of = option_chain({ open_interest_as_of: '2026-08-10T14:31:30.000Z' });
  const unknown_truncation = option_chain();
  delete unknown_truncation._meta.truncated;
  const invalid_gamma = option_chain({
    contracts: [
      { contract_symbol: 'SPXW260810C05010000', expiration: '2026-08-10', strike_usd: 5010, right: 'C', gamma: -0.03, open_interest: 1_000 },
    ],
  });
  const input = {
    direction: 'bullish',
    expiration: '2026-08-10',
    now_ms,
    max_age_ms: 600_000,
  };

  assert.equal(directional_option_gex_reference({ ...input, option_chain_snapshot: wrong_ticker }), null);
  assert.equal(directional_option_gex_reference({ ...input, option_chain_snapshot: missing_expiration }), null);
  assert.equal(directional_option_gex_reference({ ...input, option_chain_snapshot: stale_greeks }), null);
  assert.equal(directional_option_gex_reference({ ...input, option_chain_snapshot: missing_oi_as_of }), null);
  assert.equal(directional_option_gex_reference({ ...input, option_chain_snapshot: future_oi_as_of }), null);
  assert.equal(directional_option_gex_reference({ ...input, option_chain_snapshot: unknown_truncation }), null);
  assert.equal(directional_option_gex_reference({ ...input, option_chain_snapshot: invalid_gamma }), null);
});

test('Dealer GEX summary walls cannot substitute for a missing directional option chain', () => {
  const result = evaluate_bullish({ option_chain_snapshot: null });

  assert.equal(result.decision, 'no_trade');
  assert.deepEqual(result.reason_codes, ['missing_call_directional_gex_reference']);
});

test('normalization retains every provider node without an application-side cap', () => {
  const strikes = [
    { strike_usd: 4900, net_gex_usd: 10, node_type: 'put_wall' },
    { strike_usd: 4970, net_gex_usd: -100 },
    { strike_usd: 4980, net_gex_usd: -90 },
    { strike_usd: 4990, net_gex_usd: -1 },
    { strike_usd: 5010, net_gex_usd: 2 },
    { strike_usd: 5020, net_gex_usd: 80 },
    { strike_usd: 5030, net_gex_usd: 70 },
    { strike_usd: 5100, net_gex_usd: 5, node_type: 'call_wall' },
  ];
  const normalized = normalize_gex_snapshot(snapshot({
    spot_usd: 5000,
    strikes,
    summary: {
      ...snapshot().summary,
      call_wall_strike_usd: 5100,
      put_wall_strike_usd: 4900,
    },
  }));
  const selected = new Set(normalized.nodes.map((node) => node.strike_usd));

  for (const required of strikes.map((node) => node.strike_usd)) {
    assert.ok(selected.has(required), `missing required structural node ${required}`);
  }
  assert.equal(normalized.nodes.length, strikes.length);
});

test('node body break and exact-node wick retest yields a simulate-only call plan', () => {
  const result = evaluate_bullish();

  assert.equal(result.decision, 'trade');
  assert.equal(result.direction, 'bullish');
  assert.equal(result.signal_type, 'gex_node_breakout_retest');
  assert.equal(result.regime, 'breakout_retest');
  assert.equal(result.local_gamma_node.strike_usd, 5000);
  assert.equal(result.option_selection.option_right, 'call');
  assert.equal(result.option_selection.strike_reference_usd, 5005);
  assert.equal(result.option_selection.strike_basis, 'max_call_gamma_oi_shifted_toward_current_price');
  assert.equal(result.option_selection.source_node.source_field, 'data.contracts[].gamma*open_interest');
  assert.equal(result.target_underlying_usd, 5010);
  assert.equal(result.gex_node_stability.matched_sample_count, 3);
  assert.equal(result.gex_node_stability.covered_bar_count, 2);
  assert.equal(result.gex_node_stability.observed_across_multiple_samples, true);
  assert.equal(result.invalidation_basis, 'underlying_confirmation_bar_wick_proxy');
  assert.match(result.signal_id, /^junk_gex_[a-f0-9]{20}$/);
  assert.match(result.setup_id, /^junk_gex_setup_[a-f0-9]{16}$/);
  assert.equal(result.setup_identity.confirmation_bar_at, '2026-08-10T14:25:00.000Z');
  assert.equal(result.execution_environment, 'simulate_only');
  assert.equal(result.real_trading_allowed, false);
  assert.equal(result.flow_dependency, 'none');
});

test('a wick that never reaches the tested node is not called a node retest', () => {
  const bars_1m = bullish_bars.map((bar, index) => (
    index === 2 ? { ...bar, open_usd: 5003, low_usd: 5002.9 } : bar
  ));
  const result = evaluate_bullish({ market_context: bullish_context({ bars_1m }) });

  assert.equal(result.decision, 'no_trade');
  assert.deepEqual(result.reason_codes, ['waiting_for_node_confirmation']);
});

test('positive local gamma rejection yields a put plan using the official option-chain Gamma and OI fields', () => {
  const result = evaluate_junk_gex_strategy({
    gex_snapshot: snapshot({ spot_usd: 5005 }),
    option_chain_snapshot: option_chain(),
    now_ms,
    market_context: {
      last_price_usd: 5006,
      vwap_usd: 5007,
      bars_1m: bearish_rejection_bars,
      gex_node_history: stable_history({ snapshot_overrides: { spot_usd: 5005 } }),
    },
  });

  assert.equal(result.decision, 'trade');
  assert.equal(result.direction, 'bearish');
  assert.equal(result.signal_type, 'gex_node_rejection');
  assert.equal(result.regime, 'node_rejection');
  assert.equal(result.local_gamma_node.strike_usd, 5010);
  assert.equal(result.option_selection.option_right, 'put');
  assert.equal(result.option_selection.strike_reference_usd, 4995);
  assert.equal(result.option_selection.strike_basis, 'max_put_gamma_oi_shifted_toward_current_price');
  assert.equal(result.option_selection.source_node.source_field, 'data.contracts[].gamma*open_interest');
  assert.equal(result.target_underlying_usd, 5000);
});

test('one completed five-minute rejection candle is sufficient without a hidden prior-bar gate', () => {
  const result = evaluate_junk_gex_strategy({
    gex_snapshot: snapshot({ spot_usd: 5005 }),
    option_chain_snapshot: option_chain(),
    now_ms,
    market_context: {
      last_price_usd: 5006,
      vwap_usd: 5007,
      bars_1m: [bearish_rejection_bars.at(-1)],
      gex_node_history: [],
    },
  });

  assert.equal(result.decision, 'trade');
  assert.equal(result.setup_type, 'node_rejection');
  assert.equal(result.setup_identity.confirmation_bar_at, '2026-08-10T14:25:00.000Z');
});

test('a body-crossing candle is not mislabeled as a same-side node rejection', () => {
  const crossed = {
    ...bearish_rejection_bars.at(-1),
    open_usd: 5011.2,
    high_usd: 5012,
  };
  const result = evaluate_junk_gex_strategy({
    gex_snapshot: snapshot({ spot_usd: 5005 }),
    option_chain_snapshot: option_chain(),
    now_ms,
    market_context: {
      last_price_usd: 5006,
      vwap_usd: 5007,
      bars_1m: [crossed],
      gex_node_history: [],
    },
  });

  assert.equal(result.decision, 'no_trade');
  assert.deepEqual(result.reason_codes, ['waiting_for_node_confirmation']);
});

test('Gamma sign remains optional context when valid ranked structure is zero-valued', () => {
  const zeroNodes = snapshot().strikes.map((node) => ({ ...node, net_gex_usd: 0 }));
  const result = evaluate_junk_gex_strategy({
    gex_snapshot: snapshot({ spot_usd: 5005, strikes: zeroNodes }),
    option_chain_snapshot: option_chain(),
    now_ms,
    market_context: {
      last_price_usd: 5006,
      vwap_usd: 5007,
      bars_1m: [bearish_rejection_bars.at(-1)],
      gex_node_history: [],
    },
  });

  assert.equal(result.decision, 'trade');
  assert.equal(result.local_gamma_node, null);
  assert.equal(result.nearest_ranked_node_gamma_sign, 'zero_or_unknown');
});

test('the nearest ranked node Gamma sign is context and does not veto price rejection', () => {
  const negativeLocalNodes = snapshot().strikes.map((node) => (
    node.strike_usd === 5010 ? { ...node, net_gex_usd: -4_000_000 } : node
  ));
  const result = evaluate_junk_gex_strategy({
    gex_snapshot: snapshot({ spot_usd: 5005, strikes: negativeLocalNodes }),
    option_chain_snapshot: option_chain(),
    now_ms,
    market_context: {
      last_price_usd: 5006,
      vwap_usd: 5007,
      bars_1m: bearish_rejection_bars,
      gex_node_history: stable_history({ snapshot_overrides: { spot_usd: 5005 } }),
    },
  });

  assert.equal(result.decision, 'trade');
  assert.equal(result.signal_type, 'gex_node_rejection');
  assert.equal(result.nearest_ranked_node_gamma_sign, 'negative');
});

test('bearish body-cross breakout and retest is supported symmetrically', () => {
  const result = evaluate_junk_gex_strategy({
    gex_snapshot: snapshot(),
    option_chain_snapshot: option_chain(),
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

test('a later retest remains eligible after intervening bars hold the accepted side', () => {
  const bars_1m = [
    { ...bullish_bars[0], timestamp: '2026-08-10T14:10:00.000Z' },
    { ...bullish_bars[1], timestamp: '2026-08-10T14:15:00.000Z' },
    {
      timestamp: '2026-08-10T14:20:00.000Z',
      open_usd: 5003,
      high_usd: 5004,
      low_usd: 5001,
      close_usd: 5002,
      volume: 1100,
    },
    bullish_bars[2],
  ];
  const result = evaluate_bullish({ market_context: bullish_context({ bars_1m }) });

  assert.equal(result.decision, 'trade');
  assert.equal(result.setup_type, 'breakout_retest');
  assert.equal(result.setup_identity.impulse_bar_at, '2026-08-10T14:15:00.000Z');
  assert.equal(result.setup_identity.confirmation_bar_at, '2026-08-10T14:25:00.000Z');
});

test('signal identity remains stable when only the current GEX poll timestamp changes', () => {
  const first = evaluate_bullish();
  const second = evaluate_junk_gex_strategy({
    gex_snapshot: snapshot({ snapshot_at: '2026-08-10T14:31:15.000Z' }),
    option_chain_snapshot: option_chain(),
    now_ms: Date.parse('2026-08-10T14:31:15.000Z'),
    market_context: bullish_context(),
  });

  assert.equal(first.decision, 'trade');
  assert.equal(second.decision, 'trade');
  assert.equal(second.signal_id, first.signal_id);
  assert.equal(second.setup_id, first.setup_id);
});

test('node history remains audit context and does not veto confirmed price action', () => {
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

  assert.equal(result.decision, 'trade');
  assert.equal(result.gex_node_stability.matched_sample_count, 1);
  assert.equal(result.gex_node_stability.observed_across_multiple_samples, false);
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

test('an otherwise-valid setup is not blocked by an invented point-distance drift cap', () => {
  const result = evaluate_bullish({
    market_context: bullish_context({ last_price_usd: 5008 }),
  });

  assert.equal(result.decision, 'trade');
  assert.equal(result.last_price_usd, 5008);
});

test('bearish setups apply the same stop-target checks without an invented drift cap', () => {
  const market_context = {
    last_price_usd: 5006,
    vwap_usd: 5007,
    bars_1m: bearish_rejection_bars,
    gex_node_history: stable_history({ snapshot_overrides: { spot_usd: 5005 } }),
  };
  const input = {
    gex_snapshot: snapshot({ spot_usd: 5005 }),
    option_chain_snapshot: option_chain(),
    now_ms,
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
  assert.equal(drifted.decision, 'trade');
});

test('the confirmed retest wick defines the structural invalidation instead of an arbitrary point buffer', () => {
  const bars_1m = bullish_bars.map((bar, index) => (
    index === 2 ? { ...bar, low_usd: 4998.5 } : bar
  ));
  const result = evaluate_bullish({ market_context: bullish_context({ bars_1m }) });

  assert.equal(result.decision, 'trade');
  assert.equal(result.stop_underlying_usd, 4998.5);
});

test('a confirmed JUNKMAN node reaction is not vetoed by an invented reward-risk threshold', () => {
  const bars_1m = bullish_bars.map((bar, index) => (
    index === 2 ? { ...bar, low_usd: 4997 } : bar
  ));
  const result = evaluate_bullish({ market_context: bullish_context({ bars_1m }) });

  assert.equal(result.decision, 'trade');
  assert.ok(result.reward_risk_ratio < 1);
  assert.equal(result.target_underlying_usd, 5010);
  assert.equal(result.stop_underlying_usd, 4997);
});

test('a breakout impulse that starts on the destination side is rejected', () => {
  const bars_1m = bullish_bars.map((bar, index) => (
    index === 1
      ? { ...bar, open_usd: 5000.5 }
      : (index === 2 ? { ...bar, open_usd: 5004, close_usd: 5004 } : bar)
  ));
  const result = evaluate_bullish({ market_context: bullish_context({ bars_1m }) });

  assert.equal(result.decision, 'no_trade');
  assert.deepEqual(result.reason_codes, ['waiting_for_node_confirmation']);
});

test('bearish retest high defines invalidation while an impulse from the wrong side is rejected', () => {
  const crossed_stop = bearish_breakout_bars.map((bar, index) => (
    index === 2 ? { ...bar, open_usd: 4996, close_usd: 4996, high_usd: 5001.5 } : bar
  ));
  const wrong_side = bearish_breakout_bars.map((bar, index) => (
    index === 1
      ? { ...bar, open_usd: 4999.5 }
      : (index === 2 ? { ...bar, open_usd: 4996, close_usd: 4996 } : bar)
  ));
  const market_context = {
    last_price_usd: 4996,
    vwap_usd: 4998,
    gex_node_history: stable_history(),
  };
  const crossed = evaluate_junk_gex_strategy({
    gex_snapshot: snapshot(),
    option_chain_snapshot: option_chain(),
    now_ms,
    market_context: { ...market_context, bars_1m: crossed_stop },
  });
  const wrong = evaluate_junk_gex_strategy({
    gex_snapshot: snapshot(),
    option_chain_snapshot: option_chain(),
    now_ms,
    market_context: { ...market_context, bars_1m: wrong_side },
  });

  assert.equal(crossed.decision, 'trade');
  assert.equal(crossed.stop_underlying_usd, 5001.5);
  assert.deepEqual(wrong.reason_codes, ['waiting_for_node_confirmation']);
});

test('stale snapshots are blocked before any setup can trade', () => {
  const result = evaluate_bullish({
    gex_snapshot: snapshot({ snapshot_at: '2026-08-10T14:00:00.000Z' }),
  });

  assert.equal(result.decision, 'no_trade');
  assert.ok(result.reason_codes.includes('snapshot_stale'));
});

test('active policy follows the fixed five-minute sampling contract with an inclusive ten-minute boundary', () => {
  assert.equal(active_policy.provider.broker_reconcile_poll_seconds, 15);
  assert.equal(active_policy.provider.fixed_sample_interval_seconds, 300);
  assert.equal(active_policy.provider.read_model_max_attempts_per_bucket, 3);
  assert.equal('gex_snapshot_poll_seconds' in active_policy.provider, false);
  assert.equal('heatmap_snapshot_poll_seconds' in active_policy.provider, false);
  assert.equal(active_policy.strategy.max_snapshot_age_ms, 600_000);
  assert.equal('max_closed_bar_age_ms' in active_policy.strategy, false);
  assert.equal('max_closed_bar_age_ms' in DEFAULT_JUNK_GEX_POLICY, false);
  for (const removed_gate of [
    'min_displacement_points',
    'min_body_points',
    'min_reward_risk_ratio',
    'max_entry_drift_points',
    'min_impulse_volume_ratio',
    'min_gex_node_history_samples',
    'preferred_gex_node_history_bar_coverage',
    'require_gex_node_history_bar_coverage',
    'allow_positive_gamma_single_leg_mean_reversion',
    'require_vwap_confirmation',
  ]) {
    assert.equal(removed_gate in active_policy.strategy, false, `${removed_gate} must not return`);
  }
  assert.equal(active_policy.strategy.entry_start_time_et, '09:30');
  assert.equal(active_policy.strategy.entry_cutoff_time_et, '15:45');
  assert.equal(active_policy.strategy.cooldown_seconds, 0);
  assert.equal(active_policy.exit_rules.close_exit_start_time_et, '15:45');
  assert.equal(active_policy.exit_rules.force_close_exit_start_time_et, '15:55');
  assert.equal(active_policy.execution_quality.require_open_interest_and_volume, false);
  assert.equal(active_policy.execution_quality.min_open_interest, 0);
  assert.equal(active_policy.execution_quality.min_option_day_volume, 0);
  assert.equal('quota_entry_safety_floor' in active_policy.provider, false);
  assert.equal('max_nodes' in active_policy.strategy, false);
  assert.equal(active_policy.risk_limits.max_option_quote_age_seconds, 3);
  assert.equal(active_policy.risk_limits.max_trades_per_day, null);
  assert.equal(active_policy.risk_limits.max_daily_realized_loss_usd, null);
  assert.equal('max_contracts_per_line' in active_policy.risk_limits, false);
  assert.equal('max_contracts_per_trade' in active_policy.risk_limits, false);
  assert.equal('require_ranked_node_when_fresh' in active_policy.evidence_gates.heatmap, false);
  assert.equal('conflict_veto_enabled' in active_policy.evidence_gates.heatmap, false);
  assert.equal('node_tolerance_points' in active_policy.evidence_gates.heatmap, false);
  assert.equal('conflict_veto_enabled' in active_policy.evidence_gates.automated_flow_alert, false);
  assert.equal(active_policy.execution_quality.require_tick_size, true);
  assert.equal(active_policy.execution_quality.max_spread_pct_of_mid, null);
  assert.equal(active_policy.execution_quality.max_round_trip_loss_pct, null);
  assert.equal(active_policy.execution_quality.slippage_pct_of_spread, 0);
  assert.equal(active_policy.execution_quality.max_qty_to_ask_volume_ratio, 1);
  assert.deepEqual(active_policy.exit_rules.setup_time_stop_setup_types, ['range_mean_reversion']);
  assert.equal('setup_time_stop_requires_nonpositive_return' in active_policy.exit_rules, false);
  const policy = active_policy.strategy;
  const at = (age_ms, meta_seconds = null) => evaluate_bullish({
    gex_snapshot: {
      data: snapshot({ snapshot_at: new Date(now_ms - age_ms).toISOString() }),
      ...(meta_seconds === null ? {} : { _meta: { data_freshness_seconds: meta_seconds } }),
    },
    policy,
  });

  assert.ok(!at(300_000).reason_codes.includes('snapshot_stale'));
  assert.ok(!at(599_999).reason_codes.includes('snapshot_stale'));
  assert.ok(!at(600_000).reason_codes.includes('snapshot_stale'));
  assert.ok(at(600_001).reason_codes.includes('snapshot_stale'));
});

test('provider freshness metadata cannot make a stale payload fresh or vice versa', () => {
  const policy = active_policy.strategy;
  const payload_fresh_meta_stale = evaluate_bullish({
    gex_snapshot: {
      data: snapshot({ snapshot_at: new Date(now_ms - 1_000).toISOString() }),
      _meta: { data_freshness_seconds: 600.001 },
    },
    policy,
  });
  assert.ok(payload_fresh_meta_stale.reason_codes.includes('snapshot_meta_stale'));

  const payload_stale_meta_fresh = evaluate_bullish({
    gex_snapshot: {
      data: snapshot({ snapshot_at: new Date(now_ms - 600_001).toISOString() }),
      _meta: { data_freshness_seconds: 1 },
    },
    policy,
  });
  assert.ok(payload_stale_meta_fresh.reason_codes.includes('snapshot_stale'));
  assert.ok(!payload_stale_meta_fresh.reason_codes.includes('snapshot_meta_stale'));

  const meta_future = evaluate_bullish({
    gex_snapshot: {
      data: snapshot({ snapshot_at: new Date(now_ms - 1_000).toISOString() }),
      _meta: { data_freshness_seconds: -5.001 },
    },
    policy,
  });
  assert.ok(meta_future.reason_codes.includes('snapshot_meta_from_future'));
});

test('the latest closed bar must be valid and same-session while a breakout needs usable contiguous prior context', () => {
  const missing_timestamp = evaluate_bullish({
    market_context: bullish_context({
      bars_1m: bullish_bars.map(({ timestamp: _timestamp, ...bar }) => bar),
    }),
  });
  const gap = evaluate_bullish({
    market_context: bullish_context({
      bars_1m: bullish_bars.map((bar, index) => (
        index === 1
          ? { ...bar, timestamp: '2026-08-10T14:18:30.000Z' }
          : (index === 2 ? { ...bar, open_usd: 5004, close_usd: 5004 } : bar)
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
  const unclosed = evaluate_bullish({
    now_ms: Date.parse('2026-08-10T14:34:00.000Z'),
    market_context: bullish_context({
      bars_1m: bullish_bars.map((bar) => ({
        ...bar,
        timestamp: new Date(Date.parse(bar.timestamp) + 300_000).toISOString(),
      })),
    }),
  });
  const before_next_close = evaluate_bullish({ now_ms: Date.parse('2026-08-10T14:34:00.000Z') });

  assert.ok(missing_timestamp.reason_codes.includes('invalid_closed_confirmation_bar'));
  assert.deepEqual(gap.reason_codes, ['waiting_for_node_confirmation']);
  assert.ok(cross_session.reason_codes.includes('closed_confirmation_bars_cross_et_session'));
  assert.ok(unclosed.reason_codes.includes('latest_confirmation_bar_not_closed'));
  assert.equal(before_next_close.decision, 'trade');
});

test('VWAP disagreement remains audit context and cannot veto a confirmed node reaction', () => {
  const result = evaluate_bullish({
    market_context: bullish_context({ vwap_usd: 5008 }),
  });

  assert.equal(result.decision, 'trade');
  assert.equal(result.vwap_usd, 5008);
  assert.equal(result.reason_codes.includes('vwap_confirmed'), false);
});

test('missing VWAP remains explicit audit context without becoming a hidden entry gate', () => {
  const result = evaluate_bullish({
    market_context: bullish_context({ vwap_usd: null }),
  });

  assert.equal(result.decision, 'trade');
  assert.equal(result.vwap_usd, null);
});

test('five-minute confirmation requires real volume but no invented prior-bar ratio', () => {
  const missing = evaluate_bullish({
    market_context: bullish_context({
      bars_1m: bullish_bars.map((bar, index) => (index === 2 ? { ...bar, volume: null } : bar)),
    }),
  });
  const weak = evaluate_bullish({
    market_context: bullish_context({
      bars_1m: bullish_bars.map((bar, index) => (index === 1 ? { ...bar, volume: 900 } : bar)),
    }),
  });

  assert.ok(missing.reason_codes.includes('missing_closed_bar_volume'));
  assert.equal(weak.decision, 'trade');
});

test('Gamma Flip stays in summary context but is not synthesized as a tradable node', () => {
  const normalized = normalize_gex_snapshot(snapshot({
    summary: { ...snapshot().summary, gamma_flip_usd: 5005 },
  }));
  const flip = normalized.nodes.find((node) => node.strike_usd === 5005);

  assert.equal(normalized.gamma_flip_usd, 5005);
  assert.equal(flip, undefined);
});

test('a provider-ranked node may retain a matching Gamma Flip audit label', () => {
  const normalized = normalize_gex_snapshot(snapshot({
    summary: { ...snapshot().summary, gamma_flip_usd: 5000 },
  }));
  const flip = normalized.nodes.find((node) => node.strike_usd === 5000);

  assert.match(flip?.node_type || '', /gamma_flip/);
  assert.notEqual(flip?.net_gex_usd, 0);
});

test('clustered node-history samples remain audit context instead of an entry veto', () => {
  const clustered_history = [10, 20].map((seconds) => snapshot({
    snapshot_at: `2026-08-10T14:20:${seconds}.000Z`,
  }));
  const result = evaluate_bullish({
    market_context: bullish_context({ gex_node_history: clustered_history }),
  });

  assert.equal(result.decision, 'trade');
  assert.equal(result.gex_node_stability.covered_bar_count, 1);
  assert.equal(result.gex_node_stability.observed_across_multiple_samples, true);
});

test('policy cannot opt the strategy into real trading', () => {
  assert.throws(
    () => evaluate_junk_gex_strategy({ policy: { real_trading_allowed: true } }),
    /restricted to simulate_only/,
  );
});
