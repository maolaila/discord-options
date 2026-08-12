import assert from 'node:assert/strict';
import test from 'node:test';
import nightwatch_flow_alert_parser from '../packages/option-signals/nightwatch-0dte-flow-alert.cjs';
import {
  build_junk_flow_context,
  create_junk_flow_context,
  evaluate_junk_flow_candidate,
  evaluate_junk_flow_windows,
  merge_junk_flow_window_evaluations,
  read_bounded_ndjson_tail,
} from '../apps/zero-dte-options/junk-flow-context.mjs';

const {
  NIGHTWATCH_GUILD_ID,
  NIGHTWATCH_ZERO_DTE_FLOW_BOT_AUTHOR_ID,
  NIGHTWATCH_ZERO_DTE_FLOW_CHANNEL_ID,
  parseNightwatchZeroDteFlowAlerts,
} = nightwatch_flow_alert_parser;

const NOW_MS = Date.parse('2026-08-10T15:00:00.000Z');

function flow_event({
  event_id,
  message_id,
  payload_index = 0,
  payload_fingerprint,
  seconds_ago = 10,
  ticker = 'SPX',
  option_right = 'call',
  dte = 0,
  aggressor = 'ask_buy',
  premium_usd = 120_000,
  strike_usd = option_right === 'call' ? 6100 : 5900,
  contract_count = 1_000,
  avg_option_price = premium_usd / contract_count / 100,
  live_eligible = true,
  observed_via = 'discord_gateway_realtime',
  is_sweep = false,
  execution_type = is_sweep ? 'sweep' : 'unspecified',
  parse_valid = true,
  premium_consistent = true,
} = {}) {
  return {
    event_id: event_id || `event_${message_id}_${payload_index}`,
    message_id: message_id || `message_${event_id}`,
    payload_index,
    payload_fingerprint: payload_fingerprint || `fingerprint_${event_id}_${payload_index}`,
    event_at: new Date(NOW_MS - (seconds_ago * 1_000)).toISOString(),
    observed_via,
    live_eligible,
    ticker,
    option_right,
    dte,
    aggressor,
    premium_usd,
    strike_usd,
    contract_count,
    avg_option_price,
    is_sweep,
    execution_type,
    parse_valid,
    premium_consistent,
  };
}

function assert_snake_case_tree(value) {
  if (Array.isArray(value)) {
    for (const child of value) assert_snake_case_tree(child);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.match(key, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, `non-snake_case key: ${key}`);
    assert_snake_case_tree(child);
  }
}

test('bounded NDJSON tail never reads the whole large file and drops its partial head', () => {
  const records = Array.from({ length: 40 }, (_, index) => JSON.stringify({ index, pad: 'x'.repeat(60) }));
  const content = Buffer.from(`${records.join('\n')}\n`);
  const calls = [];
  const fake_fs = {
    existsSync: () => true,
    statSync: () => ({ size: content.length }),
    openSync: () => 71,
    readSync: (descriptor, buffer, offset, length, position) => {
      calls.push({ descriptor, length, position });
      return content.copy(buffer, offset, position, position + length);
    },
    closeSync: () => {},
  };

  const result = read_bounded_ndjson_tail({
    file_path: 'flow.ndjson',
    fs_module: fake_fs,
    max_tail_bytes: 500,
    max_tail_rows: 3,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 500);
  assert.ok(calls[0].position > 0);
  assert.deepEqual(result.events.map((row) => row.index), [37, 38, 39]);
  assert.equal(result.diagnostics.truncated_head, true);
  assert.equal(result.diagnostics.bytes_read, 500);
});

test('context strictly isolates ineligible rows, deduplicates all identities, and aggregates 60s/180s independently', () => {
  const first = flow_event({
    event_id: 'spx_call_1',
    message_id: 'message_1',
    payload_fingerprint: 'same_payload',
    seconds_ago: 20,
    premium_usd: 120_000,
  });
  const context = build_junk_flow_context({
    now_ms: NOW_MS,
    events: [
      first,
      { ...first },
      flow_event({
        event_id: 'different_event_same_message',
        message_id: 'message_1',
        payload_fingerprint: 'different_payload',
        seconds_ago: 20,
      }),
      flow_event({
        event_id: 'different_event_same_fingerprint',
        message_id: 'message_2',
        payload_fingerprint: 'same_payload',
        seconds_ago: 20,
      }),
      flow_event({
        event_id: 'spx_call_2',
        seconds_ago: 50,
        premium_usd: 100_000,
        is_sweep: true,
      }),
      flow_event({
        event_id: 'spx_put_1',
        seconds_ago: 120,
        option_right: 'put',
        premium_usd: 20_000,
      }),
      flow_event({
        event_id: 'spy_put_1',
        seconds_ago: 70,
        ticker: 'SPY',
        option_right: 'put',
        premium_usd: 150_000,
      }),
      flow_event({
        event_id: 'spy_put_2',
        seconds_ago: 100,
        ticker: 'SPY',
        option_right: 'put',
        premium_usd: 100_000,
        is_sweep: true,
      }),
      flow_event({ event_id: 'one_dte', dte: '1DTE' }),
      flow_event({ event_id: 'rest_one_dte', dte: 1, observed_via: 'rest_history', live_eligible: true }),
      flow_event({ event_id: 'not_live', live_eligible: false }),
      flow_event({ event_id: 'wrong_side', aggressor: 'mid_market' }),
      flow_event({ event_id: 'wrong_ticker', ticker: 'QQQ' }),
      { ...flow_event({ event_id: 'previous_session' }), event_at: '2026-08-09T15:00:00.000Z' },
    ],
  });

  assert.equal(context.availability_status, 'active');
  assert.equal(context.accepted_event_count, 5);
  assert.equal(context.deduplicated_event_count, 3);
  assert.equal(context.isolated_event_count, 6);
  assert.equal(context.isolation_reason_counts.nonzero_dte, 2);
  assert.equal(context.isolation_reason_counts.rest_history, 1);
  assert.equal(context.isolation_reason_counts.not_live_eligible, 1);
  assert.equal(context.isolation_reason_counts.not_ask_buy, 1);
  assert.equal(context.isolation_reason_counts.unsupported_ticker, 1);
  assert.equal(context.isolation_reason_counts.not_current_et_session, 1);

  const short_spx = context.windows.window_60s.tickers.spx;
  assert.equal(context.windows.window_60s.event_count, 2);
  assert.equal(short_spx.call_event_count, 2);
  assert.equal(short_spx.call_premium_usd, 220_000);
  assert.equal(short_spx.sweep_count, 1);
  assert.equal(short_spx.imbalance, 1);

  const long_spx = context.windows.window_180s.tickers.spx;
  assert.equal(long_spx.call_premium_usd, 220_000);
  assert.equal(long_spx.put_premium_usd, 20_000);
  assert.equal(long_spx.event_count, 3);
  assert.equal(long_spx.imbalance, 0.833333);
  const long_spy = context.windows.window_180s.tickers.spy;
  assert.equal(long_spy.put_event_count, 2);
  assert.equal(long_spy.put_premium_usd, 250_000);
  assert.equal(long_spy.sweep_count, 1);
  assert.equal(long_spy.imbalance, -1);
  assert.deepEqual(long_spy.source_event_ids, ['spy_put_1', 'spy_put_2']);
  assert.equal(context.source_event_ids.length, 5);
  assert_snake_case_tree(context);
});

test('actual parser output keeps every alert in one message and normalizes ask for live aggregation', () => {
  const record = {
    id: 'parser-integration-message',
    guild_id: NIGHTWATCH_GUILD_ID,
    channel_id: NIGHTWATCH_ZERO_DTE_FLOW_CHANNEL_ID,
    event_type: 'MESSAGE_CREATE',
    source: 'discord_gateway_websocket',
    timestamp: '2026-08-10T14:59:55.000Z',
    captured_at: '2026-08-10T14:59:56.000Z',
    capture_lag_ms: 1_000,
    author: {
      id: NIGHTWATCH_ZERO_DTE_FLOW_BOT_AUTHOR_ID,
      username: '0DTE FLOW Alert',
      bot: true,
    },
    content: [
      '🟢 10:59 SPY 600C 买 ⚡ $125K 200张 avg $6.25',
      '🔴 10:59 SPX 6000P 买 $225K 100张 avg $22.50',
    ].join('\n'),
    embeds: [],
  };
  const parsed = parseNightwatchZeroDteFlowAlerts(record, 'live_gateway');
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((event) => event.match_index), [0, 1]);
  assert.ok(parsed.every((event) => event.aggressor_side === 'ask'));

  const context = build_junk_flow_context({ events: parsed, now_ms: NOW_MS });
  assert.equal(context.accepted_event_count, 2);
  assert.equal(context.deduplicated_event_count, 0);
  assert.equal(context.windows.window_60s.tickers.spy.call_premium_usd, 125_000);
  assert.equal(context.windows.window_60s.tickers.spy.sweep_count, 1);
  assert.equal(context.windows.window_60s.tickers.spx.put_premium_usd, 225_000);
  assert.deepEqual(context.source_message_ids, ['parser-integration-message']);
  assert.deepEqual(context.source_event_ids, parsed.map((event) => event.sub_event_id));
});

test('missing, disconnected, and connected-with-no-flow neutral are distinct', () => {
  const missing = build_junk_flow_context({
    now_ms: NOW_MS,
    source_present: false,
    source_connected: true,
  });
  const disconnected = build_junk_flow_context({
    now_ms: NOW_MS,
    source_present: true,
    source_connected: false,
  });
  const neutral = build_junk_flow_context({
    now_ms: NOW_MS,
    source_present: true,
    source_connected: true,
  });
  const old_but_same_session = build_junk_flow_context({
    now_ms: NOW_MS,
    source_present: true,
    source_connected: true,
    events: [flow_event({ event_id: 'old', seconds_ago: 181 })],
  });
  assert.equal(missing.availability_status, 'missing');
  assert.equal(disconnected.availability_status, 'disconnected');
  assert.equal(neutral.availability_status, 'neutral');
  assert.equal(old_but_same_session.accepted_event_count, 1);
  assert.equal(old_but_same_session.availability_status, 'neutral');
});

test('one event can never confirm or veto, while two strong supportive events can confirm', () => {
  const single_context = build_junk_flow_context({
    now_ms: NOW_MS,
    events: [flow_event({ event_id: 'single', premium_usd: 500_000, is_sweep: true })],
  });
  const single = evaluate_junk_flow_candidate({
    flow_context: single_context,
    candidate_direction: 'bull',
    candidate_spot_usd: 6000,
    policy: {
      min_confirming_event_count: 1,
      min_opposite_event_count: 1,
    },
  });
  assert.equal(single.decision, 'neutral');
  assert.deepEqual(single.reason_codes, ['single_flow_event_neutral']);

  const confirmed_context = build_junk_flow_context({
    now_ms: NOW_MS,
    events: [
      flow_event({ event_id: 'call_1', premium_usd: 125_000, is_sweep: true }),
      flow_event({ event_id: 'call_2', premium_usd: 125_000, is_sweep: true }),
    ],
  });
  const confirmed = evaluate_junk_flow_candidate({
    flow_context: confirmed_context,
    candidate_direction: 'bull',
    candidate_spot_usd: 6000,
  });
  assert.equal(confirmed.decision, 'confirm');
  assert.deepEqual(confirmed.reason_codes, ['spx_large_otm_same_strike_sweep_confirmed']);
  assert.equal(confirmed.quality_complete, true);
  assert.equal(confirmed.decision_evidence_ticker, 'spx');
  assert.equal(confirmed.ticker_results.spx.supportive_event_count, 2);
  assert.deepEqual(confirmed.source_event_ids, ['call_1', 'call_2']);
  assert.equal('signal' in confirmed, false);
  assert.equal('trade_intent' in confirmed, false);
});

test('missing quality dimensions, non-sweeps, and non-OTM events stay neutral and never veto', () => {
  const context = build_junk_flow_context({
    now_ms: NOW_MS,
    events: [
      flow_event({
        event_id: 'incomplete_put_1',
        option_right: 'put',
        premium_usd: 900_000,
        is_sweep: true,
        premium_consistent: false,
      }),
      flow_event({
        event_id: 'incomplete_put_2',
        option_right: 'put',
        premium_usd: 900_000,
        is_sweep: true,
        parse_valid: false,
      }),
      flow_event({
        event_id: 'ordinary_put_1',
        option_right: 'put',
        premium_usd: 900_000,
      }),
      flow_event({
        event_id: 'ordinary_put_2',
        option_right: 'put',
        premium_usd: 900_000,
      }),
      flow_event({
        event_id: 'itm_put_1',
        option_right: 'put',
        strike_usd: 6100,
        premium_usd: 900_000,
        is_sweep: true,
      }),
      flow_event({
        event_id: 'itm_put_2',
        option_right: 'put',
        strike_usd: 6100,
        premium_usd: 900_000,
        is_sweep: true,
      }),
    ],
  });
  const result = evaluate_junk_flow_candidate({
    flow_context: context,
    candidate_direction: 'bull',
    candidate_spot_usd: 6000,
  });
  assert.equal(result.decision, 'neutral');
  assert.equal(result.can_veto_candidate, false);
  assert.equal(result.quality_complete, false);
  assert.deepEqual(result.reason_codes, ['spx_flow_quality_incomplete_neutral']);
  assert.ok(result.ticker_results.spx.quality_reason_counts.not_sweep >= 2);
  assert.ok(result.ticker_results.spx.quality_reason_counts.not_otm_itm >= 2);
});

test('same-strike repetition is mandatory and SPY quality flow is auxiliary only', () => {
  const split_strikes = build_junk_flow_context({
    now_ms: NOW_MS,
    events: [
      flow_event({ event_id: 'call_6100', strike_usd: 6100, is_sweep: true }),
      flow_event({ event_id: 'call_6150', strike_usd: 6150, is_sweep: true }),
    ],
  });
  const split = evaluate_junk_flow_candidate({
    flow_context: split_strikes,
    candidate_direction: 'bull',
    candidate_spot_usd: 6000,
  });
  assert.equal(split.decision, 'neutral');
  assert.deepEqual(split.reason_codes, ['spx_same_strike_repetition_missing_neutral']);

  const spy_only = build_junk_flow_context({
    now_ms: NOW_MS,
    events: [
      flow_event({ event_id: 'spy_call_1', ticker: 'SPY', strike_usd: 610, is_sweep: true }),
      flow_event({ event_id: 'spy_call_2', ticker: 'SPY', strike_usd: 610, is_sweep: true }),
    ],
  });
  const auxiliary = evaluate_junk_flow_candidate({
    flow_context: spy_only,
    candidate_direction: 'bull',
    candidate_spot_usd: 6000,
    spy_spot_usd: 600,
  });
  assert.equal(auxiliary.decision, 'neutral');
  assert.equal(auxiliary.ticker_results.spy.raw_decision, 'confirm');
  assert.equal(auxiliary.ticker_results.spy.decision, 'neutral');
  assert.deepEqual(auxiliary.reason_codes, ['spy_auxiliary_only_neutral']);
});

test('only quality-complete SPX can veto and SPY cannot override SPX', () => {
  const veto_context = build_junk_flow_context({
    now_ms: NOW_MS,
    events: [
      flow_event({ event_id: 'call_weak', premium_usd: 90_000, is_sweep: true }),
      flow_event({ event_id: 'put_1', option_right: 'put', premium_usd: 120_000, is_sweep: true }),
      flow_event({ event_id: 'put_2', option_right: 'put', premium_usd: 120_000, is_sweep: true }),
    ],
  });
  const veto = evaluate_junk_flow_candidate({
    flow_context: veto_context,
    candidate_direction: 'bull',
    candidate_spot_usd: 6000,
  });
  assert.equal(veto.decision, 'conflict_veto');
  assert.deepEqual(veto.reason_codes, ['spx_large_otm_same_strike_sweep_conflict_veto']);
  assert.equal(veto.ticker_results.spx.opposite_ratio_unbounded, true);

  const conflict_context = build_junk_flow_context({
    now_ms: NOW_MS,
    events: [
      flow_event({ event_id: 'spx_call_1', ticker: 'SPX', premium_usd: 130_000, is_sweep: true }),
      flow_event({ event_id: 'spx_call_2', ticker: 'SPX', premium_usd: 130_000, is_sweep: true }),
      flow_event({ event_id: 'spy_put_1', ticker: 'SPY', option_right: 'put', strike_usd: 590, premium_usd: 130_000, is_sweep: true }),
      flow_event({ event_id: 'spy_put_2', ticker: 'SPY', option_right: 'put', strike_usd: 590, premium_usd: 130_000, is_sweep: true }),
    ],
  });
  const conflict = evaluate_junk_flow_candidate({
    flow_context: conflict_context,
    candidate_direction: 'bull',
    candidate_spot_usd: 6000,
    spy_spot_usd: 600,
  });
  assert.equal(conflict.decision, 'confirm');
  assert.deepEqual(conflict.reason_codes, ['spx_large_otm_same_strike_sweep_confirmed']);
  assert.equal(conflict.ticker_results.spy.raw_decision, 'conflict_veto');
  assert.equal(conflict.ticker_results.spy.decision, 'neutral');

  const relaxed_veto = evaluate_junk_flow_candidate({
    flow_context: build_junk_flow_context({
      now_ms: NOW_MS,
      events: [
        flow_event({ event_id: 'small_put_1', option_right: 'put', premium_usd: 60_000, is_sweep: true }),
        flow_event({ event_id: 'small_put_2', option_right: 'put', premium_usd: 60_000, is_sweep: true }),
      ],
    }),
    candidate_direction: 'bull',
    candidate_spot_usd: 6000,
    policy: { min_opposite_premium_usd: 100_000, min_large_sweep_premium_usd: 50_000 },
  });
  assert.equal(relaxed_veto.decision, 'conflict_veto');
});

test('multi-window merge gives veto precedence and retains complete per-window audit', () => {
  const merged = merge_junk_flow_window_evaluations([
    {
      candidate_direction: 'bull',
      decision: 'confirm',
      availability_status: 'active',
      window_seconds: 60,
      quality_complete: true,
      decision_evidence_ticker: 'spx',
      decision_source_message_ids: ['message_1'],
      decision_source_event_ids: ['event_1'],
      source_message_ids: ['message_1'],
      source_event_ids: ['event_1'],
      reason_codes: ['spx_large_otm_same_strike_sweep_confirmed'],
    },
    {
      candidate_direction: 'bull',
      decision: 'conflict_veto',
      availability_status: 'active',
      window_seconds: 180,
      quality_complete: true,
      decision_evidence_ticker: 'spx',
      decision_source_message_ids: ['message_2'],
      decision_source_event_ids: ['event_2'],
      source_message_ids: ['message_1', 'message_2'],
      source_event_ids: ['event_1', 'event_2'],
      reason_codes: ['spx_large_otm_same_strike_sweep_conflict_veto'],
    },
  ]);

  assert.equal(merged.decision, 'conflict_veto');
  assert.deepEqual(merged.evaluated_windows_seconds, [60, 180]);
  assert.deepEqual(merged.source_message_ids, ['message_1', 'message_2']);
  assert.deepEqual(merged.source_event_ids, ['event_1', 'event_2']);
  assert.deepEqual(merged.reason_codes, [
    'spx_large_otm_same_strike_sweep_confirmed',
    'spx_large_otm_same_strike_sweep_conflict_veto',
  ]);
  assert.deepEqual(merged.decision_source_event_ids, ['event_2']);
  assert.equal(merged.per_window.window_60s.decision, 'confirm');
  assert.equal(merged.per_window.window_180s.decision, 'conflict_veto');
  assert.equal('signal' in merged, false);
  assert.equal('trade_intent' in merged, false);
});

test('multi-window evaluation uses every configured window with veto-confirm-neutral precedence', () => {
  const context = build_junk_flow_context({
    now_ms: NOW_MS,
    events: [
      flow_event({ event_id: 'recent_call_1', message_id: 'recent_1', seconds_ago: 10, premium_usd: 100_000, is_sweep: true }),
      flow_event({ event_id: 'recent_call_2', message_id: 'recent_2', seconds_ago: 20, premium_usd: 100_000, is_sweep: true }),
      flow_event({ event_id: 'older_put_1', message_id: 'older_1', seconds_ago: 90, option_right: 'put', premium_usd: 250_000, is_sweep: true }),
      flow_event({ event_id: 'older_put_2', message_id: 'older_2', seconds_ago: 120, option_right: 'put', premium_usd: 250_000, is_sweep: true }),
    ],
  });
  const vetoed = evaluate_junk_flow_windows({
    flow_context: context,
    candidate_direction: 'bull',
    candidate_spot_usd: 6000,
    windows_seconds: [60, 180],
  });
  assert.equal(vetoed.per_window.window_60s.decision, 'confirm');
  assert.equal(vetoed.per_window.window_180s.decision, 'conflict_veto');
  assert.equal(vetoed.decision, 'conflict_veto');
  assert.deepEqual(vetoed.source_message_ids, ['recent_1', 'recent_2', 'older_1', 'older_2']);

  const confirmed = merge_junk_flow_window_evaluations([
    { decision: 'neutral', window_seconds: 60, reason_codes: ['flow_neutral'] },
    {
      decision: 'confirm',
      window_seconds: 180,
      quality_complete: true,
      decision_evidence_ticker: 'spx',
      reason_codes: ['spx_large_otm_same_strike_sweep_confirmed'],
    },
  ]);
  assert.equal(confirmed.decision, 'confirm');
  const neutral = merge_junk_flow_window_evaluations([
    { decision: 'neutral', window_seconds: 60, reason_codes: ['flow_neutral'] },
    { decision: 'neutral', window_seconds: 180, reason_codes: ['flow_neutral'] },
  ]);
  assert.equal(neutral.decision, 'neutral');
  assert.deepEqual(neutral.reason_codes, ['flow_neutral']);
});

test('bear candidate maps put flow to support and factory injects fs, clock, and connectivity', () => {
  const content = Buffer.from(`${JSON.stringify(flow_event({
    event_id: 'put_1',
    option_right: 'put',
    premium_usd: 110_000,
    is_sweep: true,
  }))}\n${JSON.stringify(flow_event({
    event_id: 'put_2',
    option_right: 'put',
    premium_usd: 110_000,
    is_sweep: true,
  }))}\n`);
  const fake_fs = {
    existsSync: () => true,
    statSync: () => ({ size: content.length }),
    openSync: () => 3,
    readSync: (_descriptor, buffer, offset, length, position) => content.copy(
      buffer,
      offset,
      position,
      position + length,
    ),
    closeSync: () => {},
  };
  let connected = true;
  const reader = create_junk_flow_context({
    file_path: 'flow.ndjson',
    fs_module: fake_fs,
    now_ms: () => NOW_MS,
    source_connected: () => connected,
  });
  const context = reader.build_context();
  const evaluation = reader.evaluate({
    candidate_direction: 'bear',
    candidate_spot_usd: 6000,
    flow_context: context,
  });
  assert.equal(context.availability_status, 'active');
  assert.equal(evaluation.decision, 'confirm');
  assert.equal(evaluation.ticker_results.spx.supportive_right, 'put');

  connected = false;
  const offline = reader.build_context();
  assert.equal(offline.availability_status, 'disconnected');
  assert.deepEqual(reader.evaluate({
    candidate_direction: 'bear',
    flow_context: offline,
  }).reason_codes, ['flow_source_disconnected']);
});
