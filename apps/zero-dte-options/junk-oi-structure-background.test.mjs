import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attach_junk_oi_structure_background,
  build_junk_oi_structure_background,
  junk_oi_history_snapshot_identity,
  merge_junk_oi_history_snapshots,
  parse_spx_osi_contract,
} from './junk-oi-structure-background.mjs';

function oiResponse({
  activity = '2026-08-13',
  effective = '2026-08-14',
  asOf = `${effective}T12:00:00.000Z`,
  state = 'fresh',
  contracts,
} = {}) {
  return {
    _meta: { as_of: asOf, state },
    data: {
      contracts: contracts || [
        {
          contract: 'SPXW260814C05000000',
          prev_date: activity,
          date: effective,
          oi: 900,
          prev_oi: 600,
          oi_diff: 300,
          volume: 1_000,
          trades: 120,
          avg_price_usd: 2,
          premium_usd: 250_000,
        },
      ],
    },
  };
}

function volumeResponse({ asOf = '2026-08-14T12:00:00.000Z', state = 'fresh' } = {}) {
  return {
    _meta: { as_of: asOf, state },
    data: {
      ticker: 'SPX',
      call_volume: 10_000,
      put_volume: 8_000,
      call_premium_usd: 4_000_000,
      put_premium_usd: 3_000_000,
      signed_net_premium_usd: -125_000,
      average_volume_3d: 15_000,
    },
  };
}

function build(input = {}) {
  return build_junk_oi_structure_background({
    oi_change_response: oiResponse(),
    options_volume_response: volumeResponse(),
    expected_activity_trade_date: '2026-08-13',
    expected_oi_effective_date: '2026-08-14',
    captured_at: '2026-08-14T12:05:00.000Z',
    ...input,
  });
}

test('strict OSI parser accepts only valid SPX/SPXW contracts and preserves Call/Put identity', () => {
  assert.deepEqual(parse_spx_osi_contract('SPXW260814C05000000'), {
    contract: 'SPXW260814C05000000',
    root: 'SPXW',
    ticker: 'SPX',
    expiration: '2026-08-14',
    right: 'call',
    strike_usd: 5000,
  });
  assert.equal(parse_spx_osi_contract('SPX260918P04950000')?.right, 'put');
  assert.equal(parse_spx_osi_contract('SPY260814C00500000'), null);
  assert.equal(parse_spx_osi_contract('BRK.B260814C00500000'), null);
  assert.equal(parse_spx_osi_contract('SPXW260231C05000000'), null);
  assert.equal(parse_spx_osi_contract('SPXW260814X05000000'), null);
});

test('normalizes dual-date OI and options-volume context with official premium precedence', () => {
  const result = build({
    oi_change_response: oiResponse({
      contracts: [
        {
          contract: 'SPXW260814C05000000', prev_date: '2026-08-13', date: '2026-08-14',
          oi: 900, prev_oi: 600, oi_diff: 300, volume: 1_000, trades: 120,
          avg_price_usd: 2, premium_usd: 250_000,
        },
        {
          contract: 'SPX260918C05000000', prev_date: '2026-08-13', date: '2026-08-14',
          oi: 700, prev_oi: 500, oi_diff: 200, volume: 50, trades: 20, avg_price_usd: 3,
        },
        {
          contract: 'SPX260918P05000000', prev_date: '2026-08-13', date: '2026-08-14',
          oi: 400, prev_oi: 450, oi_diff: -50,
        },
      ],
    }),
  });

  assert.equal(result.usable, true);
  assert.equal(result.activity_trade_date, '2026-08-13');
  assert.equal(result.oi_effective_date, '2026-08-14');
  assert.equal(result.options_volume.call_volume, 10_000);
  assert.equal(result.options_volume.signed_net_premium_usd, -125_000);
  assert.equal(result.contracts[0].premium_usd, 250_000);
  assert.equal(result.contracts[0].premium_source, 'official');
  assert.equal(result.contracts[1].premium_usd, 15_000);
  assert.equal(result.contracts[1].premium_is_estimated, true);
  assert.equal(result.contracts[2].premium_usd, null);
  assert.equal(result.contracts[2].volume, null);
  assert.equal(result.evidence.unknown_premium_contract_count, 1);
  assert.equal(result.can_trigger_trade, false);
  assert.equal(result.can_veto_candidate, false);
  assert.equal(result.intraday_directional_signal, false);
  assert.equal(result.settlement_lagged, true);
});

test('normalizes the real options.options_volume day schema as separate non-directional context', () => {
  const realSchema = {
    as_of: '2026-08-14T12:04:00.000Z',
    day: {
      date: '2026-08-14',
      call_volume: 10_000,
      put_volume: 8_000,
      call_volume_ask_side: 6_000,
      call_volume_bid_side: 3_000,
      put_volume_ask_side: 2_500,
      put_volume_bid_side: 5_000,
      net_call_premium: 900_000,
      net_put_premium: -700_000,
      bullish_premium: 4_200_000,
      bearish_premium: 3_900_000,
      call_open_interest: 100_000,
      put_open_interest: 120_000,
      avg_3_day_call_volume: 9_000,
      avg_3_day_put_volume: 7_000,
      avg_7_day_call_volume: 8_500,
      avg_7_day_put_volume: 6_500,
      avg_30_day_call_volume: 7_500,
      avg_30_day_put_volume: 6_000,
    },
  };
  const result = build({ options_volume_response: realSchema });
  assert.equal(result.usable, true);
  assert.equal(result.options_volume.date, '2026-08-14');
  assert.equal(result.options_volume.call_volume_ask_side, 6_000);
  assert.equal(result.options_volume.put_volume_bid_side, 5_000);
  assert.equal(result.options_volume.net_call_premium_usd, 900_000);
  assert.equal(result.options_volume.net_put_premium_usd, -700_000);
  assert.equal(result.options_volume.bullish_premium_usd, 4_200_000);
  assert.equal(result.options_volume.bearish_premium_usd, 3_900_000);
  assert.equal(result.options_volume.call_open_interest, 100_000);
  assert.equal(result.options_volume.put_open_interest, 120_000);
  assert.equal(result.options_volume.average_call_volume_3d, 9_000);
  assert.equal(result.options_volume.average_put_volume_7d, 6_500);
  assert.equal(result.options_volume.average_call_volume_30d, 7_500);
  assert.equal(result.options_volume.average_put_volume_30d, 6_000);
  assert.equal(result.options_volume.session_partial_or_semantically_independent, true);
  assert.equal(result.options_volume.excluded_from_score, true);
  assert.equal(result.options_volume.intraday_directional_signal, false);
});

test('aggregates exact contracts and strike+right across expiration without mixing Calls and Puts', () => {
  const result = build({
    oi_change_response: oiResponse({
      contracts: [
        { contract: 'SPXW260814C05000000', prev_date: '2026-08-13', date: '2026-08-14', oi_diff: 100, volume: 10, premium_usd: 1_000 },
        { contract: 'SPX260918C05000000', prev_date: '2026-08-13', date: '2026-08-14', oi_diff: 200, volume: 20, premium_usd: 2_000 },
        { contract: 'SPX260918P05000000', prev_date: '2026-08-13', date: '2026-08-14', oi_diff: 400, volume: 40, premium_usd: 4_000 },
      ],
    }),
  });
  assert.equal(result.contracts.length, 3);
  assert.equal(result.strikes.length, 2);
  const calls = result.strikes.find((row) => row.right === 'call');
  const puts = result.strikes.find((row) => row.right === 'put');
  assert.deepEqual(calls.expirations, ['2026-08-14', '2026-09-18']);
  assert.equal(calls.oi_diff, 300);
  assert.equal(calls.volume, 30);
  assert.equal(calls.premium_usd, 3_000);
  assert.equal(puts.oi_diff, 400);
});

test('date mismatch, stale/future source, and non-fresh state fail closed', () => {
  const mismatch = build({
    oi_change_response: oiResponse({ activity: '2026-08-12' }),
  });
  assert.equal(mismatch.usable, false);
  assert.ok(mismatch.reason_codes.includes('activity_trade_date_mismatch'));
  assert.equal(mismatch.score.value, null);

  const stale = build({
    oi_change_response: oiResponse({ asOf: '2026-08-10T12:00:00.000Z' }),
  });
  assert.equal(stale.usable, false);
  assert.ok(stale.reason_codes.includes('oi_change_source_stale'));

  const degraded = build({
    options_volume_response: volumeResponse({ state: 'stale' }),
  });
  assert.equal(degraded.usable, true);
  assert.equal(degraded.options_volume, null);
  assert.ok(degraded.optional_context_reason_codes.includes('options_volume_freshness_not_usable:stale'));

  const future = build({
    oi_change_response: oiResponse({ asOf: '2026-08-14T13:00:00.000Z' }),
  });
  assert.equal(future.usable, false);
  assert.ok(future.reason_codes.includes('oi_change_source_as_of_from_future'));

  const asOfDateMismatch = build({
    oi_change_response: oiResponse({ asOf: '2026-08-13T23:59:00.000Z' }),
  });
  assert.equal(asOfDateMismatch.usable, false);
  assert.ok(asOfDateMismatch.reason_codes.includes('oi_change_source_as_of_date_mismatch'));
  assert.equal(asOfDateMismatch.history_snapshot, null);
});

test('identity inconsistencies and missing contracts remain unknown and fail closed', () => {
  const result = build({
    oi_change_response: oiResponse({
      contracts: [
        {
          contract: 'SPXW260814C05000000', prev_date: '2026-08-13', date: '2026-08-14',
          expiration: '2026-08-15', right: 'put', strike: 4995,
        },
        { contract: 'SPY260814C00500000', prev_date: '2026-08-13', date: '2026-08-14' },
      ],
    }),
  });
  assert.equal(result.usable, false);
  assert.ok(result.reason_codes.includes('osi_expiration_mismatch'));
  assert.ok(result.reason_codes.includes('osi_right_mismatch'));
  assert.ok(result.reason_codes.includes('osi_strike_mismatch'));
  assert.ok(result.reason_codes.includes('invalid_or_non_spx_osi_contract'));
  assert.equal(result.contracts[0].oi, null);
  assert.equal(result.contracts[0].oi_diff, null);
});

test('invalid official Premium fails closed and is never silently replaced by an estimate', () => {
  const result = build({
    oi_change_response: oiResponse({
      contracts: [{
        contract: 'SPXW260814C05000000', prev_date: '2026-08-13', date: '2026-08-14',
        volume: 100, avg_price_usd: 2, premium_usd: -1,
      }],
    }),
  });
  assert.equal(result.usable, false);
  assert.ok(result.reason_codes.includes('official_premium_invalid'));
  assert.equal(result.contracts[0].premium_usd, null);
  assert.equal(result.contracts[0].premium_is_estimated, false);
  assert.equal(result.contracts[0].premium_source, 'unknown');
});

test('calculates exact-contract and strike histories while marking 5/10-day history insufficient', () => {
  const snapshots = [];
  const sessions = [
    ['2026-08-11', '2026-08-12', 100, 100, 1_000],
    ['2026-08-12', '2026-08-13', 120, 110, 1_100],
  ];
  for (const [activity, effective, oiDiff, volume, premium] of sessions) {
    const context = build_junk_oi_structure_background({
      oi_change_response: oiResponse({
        activity,
        effective,
        asOf: `${effective}T12:00:00.000Z`,
        contracts: [{
          contract: 'SPX260918C05000000', prev_date: activity, date: effective,
          oi_diff: oiDiff, volume, premium_usd: premium,
        }],
      }),
      expected_activity_trade_date: activity,
      expected_oi_effective_date: effective,
      captured_at: `${effective}T12:05:00.000Z`,
      history_snapshots: snapshots,
    });
    snapshots.push(context.history_snapshot);
  }
  const current = build({
    options_volume_response: null,
    history_snapshots: snapshots,
    oi_change_response: oiResponse({
      contracts: [{
        contract: 'SPX260918C05000000', prev_date: '2026-08-13', date: '2026-08-14',
        oi_diff: 140, volume: 121, premium_usd: 1_210,
      }],
    }),
  });
  const contractHistory = current.contracts[0].history;
  assert.equal(contractHistory.observation_count, 3);
  assert.equal(contractHistory.oi_up_streak, 3);
  assert.equal(contractHistory.premium_up_streak, 2);
  assert.equal(contractHistory.volume_up_streak, 2);
  assert.equal(contractHistory.windows['3'].sufficient_history, true);
  assert.equal(contractHistory.windows['3'].oi_diff_cumulative, 360);
  assert.equal(contractHistory.windows['3'].premium_usd_cumulative, 3_310);
  assert.deepEqual(contractHistory.insufficient_history, [5, 10]);
  assert.equal(current.strikes[0].history.windows['3'].volume_cumulative, 331);
});

test('a missing contract on an intervening snapshot is not backfilled with zero', () => {
  const current = build({
    history_snapshots: [
      {
        ticker: 'SPX', activity_trade_date: '2026-08-11', oi_effective_date: '2026-08-12',
        contracts: [{ contract: 'SPX260918C05000000', strike_usd: 5000, right: 'call', oi_diff: 10 }],
      },
      {
        ticker: 'SPX', activity_trade_date: '2026-08-12', oi_effective_date: '2026-08-13', contracts: [],
      },
    ],
    oi_change_response: oiResponse({
      contracts: [{ contract: 'SPX260918C05000000', prev_date: '2026-08-13', date: '2026-08-14', oi_diff: 30 }],
    }),
  });
  assert.equal(current.contracts[0].history.observation_count, 2);
  assert.equal(current.contracts[0].history.windows['3'].sufficient_history, false);
  assert.equal(current.contracts[0].history.windows['3'].oi_diff_cumulative, null);
});

test('history merge is idempotent by dual-date+ticker identity and retains at most 60 days', () => {
  const replacement = {
    ticker: 'SPX', activity_trade_date: '2026-08-13', oi_effective_date: '2026-08-14', contracts: [{ marker: 2 }],
  };
  const original = { ...replacement, contracts: [{ marker: 1 }] };
  assert.equal(junk_oi_history_snapshot_identity(original), '2026-08-13|2026-08-14|SPX');
  const replaced = merge_junk_oi_history_snapshots([original], replacement);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].contracts[0].marker, 2);

  let history = [];
  for (let day = 1; day <= 61; day += 1) {
    const activity = new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
    const effective = new Date(Date.UTC(2026, 0, day + 1)).toISOString().slice(0, 10);
    history = merge_junk_oi_history_snapshots(history, { ticker: 'SPX', activity_trade_date: activity, oi_effective_date: effective });
  }
  assert.equal(history.length, 60);
  assert.equal(history[0].activity_trade_date, '2026-01-02');
  assert.throws(() => merge_junk_oi_history_snapshots([], replacement, { max_days: 61 }), /between 1 and 60/);
});

test('attaching even high-score or opposite-looking context cannot mutate a trade/no-trade decision', () => {
  const trade = {
    decision: 'trade', action: 'open_long_option', direction: 'bullish',
    reason_codes: ['gex_node_confirmed'], confirmations: ['heatmap'], vetoes: [],
    evidence_model: { heatmap: { assessment: 'confirm' } },
  };
  const hostile = {
    score: { value: 100 }, inferred_direction: 'bearish',
    can_trigger_trade: true, can_veto_candidate: true,
  };
  const attachedTrade = attach_junk_oi_structure_background(trade, hostile);
  assert.equal(attachedTrade.decision, 'trade');
  assert.equal(attachedTrade.action, 'open_long_option');
  assert.equal(attachedTrade.direction, 'bullish');
  assert.deepEqual(attachedTrade.reason_codes, trade.reason_codes);
  assert.deepEqual(attachedTrade.confirmations, trade.confirmations);
  assert.deepEqual(attachedTrade.vetoes, trade.vetoes);
  assert.equal(attachedTrade.oi_structure_background.can_trigger_trade, false);
  assert.equal(attachedTrade.evidence_model.oi_structure_background.can_veto_candidate, false);
  assert.equal(attachedTrade.oi_structure_background.inferred_direction, undefined);
  assert.equal(attachedTrade.evidence_model.oi_structure_background.score, undefined);

  const noTrade = { decision: 'no_trade', action: 'wait', reason_codes: ['waiting_for_node_confirmation'] };
  const attachedNoTrade = attach_junk_oi_structure_background(noTrade, { score: { value: 100 }, can_trigger_trade: true });
  assert.equal(attachedNoTrade.decision, 'no_trade');
  assert.equal(attachedNoTrade.action, 'wait');
  assert.deepEqual(attachedNoTrade.reason_codes, noTrade.reason_codes);
  assert.equal(attachedNoTrade.oi_structure_background.can_trigger_trade, false);
});

test('decision attachment stores a bounded digest instead of duplicating daily top rows', () => {
  const attached = attach_junk_oi_structure_background(
    { decision: 'no_trade', action: 'wait', reason_codes: [] },
    {
      ticker: 'SPX', usable: true, state: 'usable_context',
      activity_trade_date: '2026-08-12', oi_effective_date: '2026-08-13',
      source_as_of: '2026-08-13T04:00:00.000Z',
      top_contracts: Array.from({ length: 50 }, (_, index) => ({ contract: `C${index}`, payload: 'x'.repeat(500) })),
      top_strikes: Array.from({ length: 50 }, (_, index) => ({ strike_usd: index, payload: 'x'.repeat(500) })),
    },
  );
  assert.equal(attached.oi_structure_background.context_id, 'SPX|2026-08-12|2026-08-13|2026-08-13T04:00:00.000Z');
  assert.equal(attached.oi_structure_background.top_contracts, undefined);
  assert.ok(JSON.stringify(attached).length < 2_000);
});
