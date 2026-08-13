import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregate_closed_1m_bars,
  aggregate_closed_5m_bars,
  create_junk_gex_market_context,
  gex_spot_alignment_at,
  map_spy_vwap_to_spx,
  normalize_spx_spot_sample,
  normalize_spy_quote_sample,
} from '../apps/zero-dte-options/junk-gex-market-context.mjs';

test('fixed-sample SPX spot aligns to the final archived minute without changing source identity', () => {
  assert.equal(
    gex_spot_alignment_at('2026-08-10T14:30:00.000Z'),
    '2026-08-10T14:34:59.000Z',
  );
  assert.equal(
    gex_spot_alignment_at('2026-08-10T14:31:12.000Z'),
    '2026-08-10T14:31:12.000Z',
  );

  const normalized = normalize_spx_spot_sample({
    ticker: 'SPX',
    snapshot_at: '2026-08-10T14:30:00.000Z',
    spot_usd: 6_000,
  });
  assert.equal(normalized.snapshot_at, '2026-08-10T14:30:00.000Z');
  assert.equal(normalized.spot_alignment_at, '2026-08-10T14:34:59.000Z');
});

test('five-minute acceptance bars require five complete minutes and aggregate SPY volume', () => {
  const bars_1m = Array.from({ length: 5 }, (_value, index) => ({
    timestamp: `2026-08-10T14:${String(20 + index).padStart(2, '0')}:00.000Z`,
    open_usd: 600 + index,
    high_usd: 601 + index,
    low_usd: 599 + index,
    close_usd: 600.5 + index,
    volume: 100 + index * 10,
  }));
  const complete = aggregate_closed_5m_bars({
    bars_1m,
    now_ms: Date.parse('2026-08-10T14:25:00.000Z'),
  });
  const incomplete = aggregate_closed_5m_bars({
    bars_1m: bars_1m.slice(0, 4),
    now_ms: Date.parse('2026-08-10T14:25:00.000Z'),
  });

  assert.equal(complete.length, 1);
  assert.equal(complete[0].timestamp, '2026-08-10T14:20:00.000Z');
  assert.equal(complete[0].close_usd, 604.5);
  assert.equal(complete[0].volume, 600);
  assert.deepEqual(incomplete, []);
});

function spx_anchor(snapshot_at, spot_usd, overrides = {}) {
  return {
    ticker: 'SPX',
    snapshot_at,
    spot_usd,
    ...overrides,
  };
}

function spy_quote(quote_received_at, cur_price_usd, avg_price_usd = null, overrides = {}) {
  return {
    quote_received_at,
    quote_source: 'push_basic',
    basic: {
      security: { code: 'SPY' },
      curPrice: cur_price_usd,
      ...(avg_price_usd === null ? {} : { avgPrice: avg_price_usd }),
    },
    ...overrides,
  };
}

function assert_snake_case_tree(value) {
  if (Array.isArray(value)) {
    for (const item of value) assert_snake_case_tree(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.match(key, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, `non-snake_case key: ${key}`);
    assert_snake_case_tree(child);
  }
}

test('generic closed-bar helper retains its exact minute-boundary behavior', () => {
  const samples = [
    { snapshot_at: '2026-08-10T14:30:00.000Z', spot_usd: 600 },
    { snapshot_at: '2026-08-10T14:30:21.000Z', spot_usd: 604 },
    { snapshot_at: '2026-08-10T14:30:59.999Z', spot_usd: 602 },
  ];

  assert.deepEqual(aggregate_closed_1m_bars({
    samples,
    now_ms: Date.parse('2026-08-10T14:30:59.999Z'),
  }), []);

  const [bar] = aggregate_closed_1m_bars({
    samples,
    now_ms: Date.parse('2026-08-10T14:31:00.000Z'),
  });
  assert.deepEqual(bar, {
    timestamp: '2026-08-10T14:30:00.000Z',
    minute_start_at: '2026-08-10T14:30:00.000Z',
    minute_end_at: '2026-08-10T14:31:00.000Z',
    open_usd: 600,
    high_usd: 604,
    low_usd: 600,
    close_usd: 602,
    sample_count: 3,
    volume: null,
    first_sample_at: '2026-08-10T14:30:00.000Z',
    last_sample_at: '2026-08-10T14:30:59.999Z',
  });
});

test('moomoo SPY push samples form raw OHLC and map to SPX with one anchor ratio', () => {
  const clock_ms = Date.parse('2026-08-10T14:31:02.000Z');
  const context = create_junk_gex_market_context({ now_ms: () => clock_ms });
  context.ingest_spy_sample(spy_quote('2026-08-10T14:30:00.000Z', 599));
  context.ingest_spy_sample(spy_quote('2026-08-10T14:30:20.000Z', 601));
  context.ingest_spy_sample(spy_quote('2026-08-10T14:30:40.000Z', 598));
  context.ingest_spy_sample(spy_quote('2026-08-10T14:30:59.000Z', 600));
  context.ingest_spy_sample(spy_quote('2026-08-10T14:31:00.000Z', 600, 594));
  context.ingest_spy_sample(spy_quote('2026-08-10T14:31:01.000Z', 600.2, 594));

  const market_context = context.build_market_context({
    spx_snapshot: { data: spx_anchor('2026-08-10T14:31:00.000Z', 6000) },
  });

  assert.equal(market_context.price_action_source, 'moomoo_spy_push_mapped_to_spx');
  assert.equal(market_context.price_action_ready, true);
  assert.equal(market_context.readiness_reason_code, 'ready');
  assert.equal(market_context.spy_to_spx_scale_ratio, 10);
  assert.equal(market_context.last_price_usd, 6002);
  assert.equal(market_context.vwap_usd, 5940);
  assert.deepEqual(
    market_context.bars_1m.map((bar) => [
      bar.open_usd,
      bar.high_usd,
      bar.low_usd,
      bar.close_usd,
      bar.sample_count,
    ]),
    [[5990, 6010, 5980, 6000, 4]],
  );

  const state = context.export_state();
  assert.deepEqual(
    state.spy_bars_1m.map((bar) => [bar.open_usd, bar.high_usd, bar.low_usd, bar.close_usd]),
    [[599, 601, 598, 600]],
  );
  assert.equal(state.spy_samples.at(-1).cur_price_usd, 600.2);
  assert_snake_case_tree(market_context);
  assert_snake_case_tree(state);
});

test('fixed-sample GEX spot uses a final-minute SPY anchor and keeps the live quote gate strict', () => {
  const clock_ms = Date.parse('2026-08-10T14:35:01.000Z');
  const context = create_junk_gex_market_context({ now_ms: () => clock_ms });
  context.ingest_spy_sample(spy_quote('2026-08-10T14:30:00.000Z', 500));
  context.ingest_spy_sample(spy_quote('2026-08-10T14:34:59.000Z', 600));
  context.ingest_spy_sample(spy_quote('2026-08-10T14:35:00.000Z', 601, 590));

  const market_context = context.build_market_context({
    spx_snapshot: spx_anchor('2026-08-10T14:30:00.000Z', 6000),
  });

  assert.equal(market_context.anchor_snapshot_at, '2026-08-10T14:30:00.000Z');
  assert.equal(market_context.anchor_spot_alignment_at, '2026-08-10T14:34:59.000Z');
  assert.equal(market_context.anchor_spy_quote_received_at, '2026-08-10T14:34:59.000Z');
  assert.equal(market_context.anchor_spy_gap_ms, 0);
  assert.equal(market_context.latest_spy_quote_age_limit_ms, 3_000);
  assert.equal(market_context.price_action_ready, true);
  assert.equal(market_context.spy_to_spx_scale_ratio, 10);
  assert.equal(market_context.last_price_usd, 6010);
});

test('a stale latest SPY quote fails closed even when anchor alignment is valid', () => {
  const clock_ms = Date.parse('2026-08-10T14:31:04.001Z');
  const context = create_junk_gex_market_context({ now_ms: () => clock_ms });
  context.ingest_spy_sample(spy_quote('2026-08-10T14:30:10.000Z', 599));
  context.ingest_spy_sample(spy_quote('2026-08-10T14:31:00.000Z', 600, 594));

  const market_context = context.build_market_context({
    spx_snapshot: spx_anchor('2026-08-10T14:31:00.000Z', 6000),
  });

  assert.equal(market_context.anchor_spy_gap_ms, 0);
  assert.equal(market_context.latest_spy_quote_age_ms, 4001);
  assert.equal(market_context.latest_spy_quote_fresh, false);
  assert.equal(market_context.price_action_ready, false);
  assert.equal(market_context.readiness_reason_code, 'stale_spy_quote');
  assert.equal(market_context.last_price_usd, null);
  assert.equal(market_context.vwap_usd, null);
  assert.deepEqual(market_context.bars_1m, []);
});

test('all historical OHLC uses one current anchor ratio and Nightwatch samples cannot manufacture wicks', () => {
  const clock_ms = Date.parse('2026-08-10T14:31:02.000Z');
  const context = create_junk_gex_market_context({ now_ms: () => clock_ms });
  context.ingest_spy_sample(spy_quote('2026-08-10T14:30:01.000Z', 100));
  context.ingest_spy_sample(spy_quote('2026-08-10T14:30:20.000Z', 101));
  context.ingest_spy_sample(spy_quote('2026-08-10T14:30:40.000Z', 99));
  context.ingest_spy_sample(spy_quote('2026-08-10T14:30:59.000Z', 100.5));
  context.ingest_spy_sample(spy_quote('2026-08-10T14:31:00.000Z', 100));

  // Wildly different historical Nightwatch anchors must not enter the bar.
  context.ingest_sample(spx_anchor('2026-08-10T14:30:01.000Z', 900));
  context.ingest_sample(spx_anchor('2026-08-10T14:30:20.000Z', 1300));
  context.ingest_sample(spx_anchor('2026-08-10T14:30:40.000Z', 700));
  const market_context = context.build_market_context({
    spx_snapshot: spx_anchor('2026-08-10T14:31:00.000Z', 1000),
  });

  assert.equal(market_context.spy_to_spx_scale_ratio, 10);
  assert.deepEqual(
    market_context.bars_1m.map((bar) => [bar.open_usd, bar.high_usd, bar.low_usd, bar.close_usd]),
    [[1000, 1010, 990, 1005]],
  );
  assert.equal(market_context.bars_1m[0].high_usd - market_context.bars_1m[0].low_usd, 20);
});

test('SPX anchor must have a SPY sample within the configured alignment window', () => {
  const clock_ms = Date.parse('2026-08-10T14:31:02.000Z');
  const context = create_junk_gex_market_context({
    now_ms: () => clock_ms,
    max_anchor_spy_gap_ms: 5_000,
  });
  context.ingest_spy_sample(spy_quote('2026-08-10T14:31:01.000Z', 600));

  const market_context = context.build_market_context({
    spx_snapshot: spx_anchor('2026-08-10T14:30:50.000Z', 6000),
  });

  assert.equal(market_context.anchor_spy_gap_ms, 11000);
  assert.equal(market_context.price_action_ready, false);
  assert.equal(market_context.readiness_reason_code, 'anchor_spy_sample_unavailable');
  assert.equal(market_context.last_price_usd, null);
  assert.deepEqual(market_context.bars_1m, []);
});

test('raw SPY samples and bars survive restart without duplicate minutes or rebasing', () => {
  let clock_ms = Date.parse('2026-08-10T14:31:02.000Z');
  const first = create_junk_gex_market_context({ now_ms: () => clock_ms });
  first.ingest_spy_sample(spy_quote('2026-08-10T14:30:01.000Z', 599));
  first.ingest_spy_sample(spy_quote('2026-08-10T14:30:59.000Z', 601));
  first.ingest_spy_sample(spy_quote('2026-08-10T14:31:00.000Z', 600, 594));
  first.ingest_sample(spx_anchor('2026-08-10T14:31:00.000Z', 6000));
  const state = first.export_state();

  const restored = create_junk_gex_market_context({
    spx_anchor_samples: state.spx_anchor_samples,
    spy_samples: state.spy_samples,
    spy_bars_1m: state.spy_bars_1m,
    now_ms: () => clock_ms,
  });
  const duplicate = restored.ingest_spy_sample(spy_quote('2026-08-10T14:31:00.000Z', 600, 594));
  assert.equal(duplicate.duplicate, true);

  const market_context = restored.build_market_context();
  assert.equal(market_context.price_action_ready, true);
  assert.deepEqual(
    market_context.bars_1m.map((bar) => [bar.open_usd, bar.close_usd, bar.sample_count]),
    [[5990, 6010, 2]],
  );
  assert.equal(restored.export_state().spy_bars_1m.length, 1);

  clock_ms = Date.parse('2026-08-10T14:32:00.000Z');
  restored.ingest_spy_sample(spy_quote('2026-08-10T14:31:59.000Z', 602));
  assert.equal(restored.export_state().spy_bars_1m.length, 2);
});

test('fifteen raw one-minute OHLCV bars reproduce the same three five-minute bars after restart', () => {
  const clock_ms = Date.parse('2026-08-10T14:45:02.000Z');
  const spy_bars_1m = Array.from({ length: 15 }, (_value, index) => {
    const minute_start_ms = Date.parse('2026-08-10T14:30:00.000Z') + index * 60_000;
    const open = 600 + index * 0.1;
    return {
      timestamp: new Date(minute_start_ms).toISOString(),
      minute_start_at: new Date(minute_start_ms).toISOString(),
      minute_end_at: new Date(minute_start_ms + 60_000).toISOString(),
      open_usd: open,
      high_usd: open + 0.2,
      low_usd: open - 0.1,
      close_usd: open + 0.1,
      sample_count: 4,
      volume: 1000 + index * 10,
      first_sample_at: new Date(minute_start_ms).toISOString(),
      last_sample_at: new Date(minute_start_ms + 59_000).toISOString(),
    };
  });
  const base = create_junk_gex_market_context({
    // This persistence-focused fixture uses a legacy exact-time anchor rather
    // than a documented fixed-bucket label (which would not yet exist at
    // 14:45:02 for the 14:45-14:50 bucket).
    spx_anchor_samples: [spx_anchor('2026-08-10T14:44:59.000Z', 6000)],
    spy_samples: [{
      quote_received_at: '2026-08-10T14:44:59.000Z',
      cur_price_usd: 600,
      avg_price_usd: 599,
      cumulative_volume: 1_000_000,
    }],
    spy_bars_1m,
    now_ms: () => clock_ms,
  });
  const before = base.build_market_context();
  const state = base.export_state();
  const restored = create_junk_gex_market_context({
    spx_anchor_samples: state.spx_anchor_samples,
    spy_samples: state.spy_samples,
    spy_bars_1m: state.spy_bars_1m,
    now_ms: () => clock_ms,
  });
  const after = restored.build_market_context();

  assert.equal(before.bars_5m.length, 3);
  assert.deepEqual(after.bars_5m, before.bars_5m);
  assert.deepEqual(after.bars_1m, before.bars_1m);
});

test('normalizers and compatibility VWAP helper reject invalid inputs', () => {
  assert.deepEqual(normalize_spy_quote_sample(spy_quote(
    '2026-08-10T14:31:00.000Z',
    600,
    594,
  )), {
    ticker: 'SPY',
    quote_received_at: '2026-08-10T14:31:00.000Z',
    cur_price_usd: 600,
    avg_price_usd: 594,
    cumulative_volume: null,
  });
  assert.equal(normalize_spy_quote_sample({
    quote_received_at: '2026-08-10T14:31:00.000Z',
    basic: { security: { code: 'QQQ' }, curPrice: 500 },
  }), null);
  assert.equal(normalize_spy_quote_sample({ basic: { curPrice: 600 } }), null);
  assert.equal(normalize_spx_spot_sample(spx_anchor('2026-08-10T14:30:00.000Z', 6000, {
    ticker: 'SPY',
  })), null);
  assert.equal(map_spy_vwap_to_spx({
    spx_spot_usd: 6000,
    spy_basic: { avgPrice: 594, curPrice: 600 },
  }), 5940);
  assert.equal(map_spy_vwap_to_spx({
    spx_spot_usd: 6000,
    spy_basic: { avgPrice: 594 },
  }), null);
});
