import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apply_junk_v2_evidence,
  evaluate_junk_heatmap_evidence,
  evaluate_junk_latest_line_entry,
} from '../apps/zero-dte-options/junk-trading-model-v2.mjs';

const NOW = Date.parse('2026-08-10T15:00:30Z');

function candidate(overrides = {}) {
  return {
    strategy: 'junk_gex_nodes_v3',
    decision: 'trade',
    action: 'open_long_option',
    direction: 'bullish',
    session_date_et: '2026-08-10',
    reason_codes: ['gex_node_confirmed'],
    tested_node: { strike_usd: 6000, net_gex_usd: 2_000_000 },
    ...overrides,
  };
}

function heatmap(overrides = {}) {
  return {
    state: 'fresh',
    generated_at: '2026-08-10T15:00:00.123456Z',
    session_date_et: '2026-08-10',
    top_rows: [{ strike_usd: 6000, row_net_wall_gex_usd: 3_000_000, row_abs_wall_gex_usd: 4_000_000 }],
    ...overrides,
  };
}

function latestHistory(overrides = {}) {
  const base = {
    ticker: 'SPX',
    session_date_et: '2026-08-10',
    state: 'fresh',
    spot_usd: 6004,
    strikes: [
      { strike_usd: 5990, net_gex_usd: 1_000_000 },
      { strike_usd: 6000, net_gex_usd: 2_000_000 },
      { strike_usd: 6010, net_gex_usd: 1_500_000 },
    ],
  };
  return [
    { ...base, snapshot_at: '2026-08-10T14:50:00Z' },
    {
      ...base,
      snapshot_at: '2026-08-10T14:55:00Z',
      strikes: base.strikes.map((row) => (
        row.strike_usd === 6000 ? { ...row, net_gex_usd: 2_100_000 } : row
      )),
      ...overrides,
    },
  ];
}

function latestMarketContext(overrides = {}) {
  return {
    last_price_usd: 6004,
    vwap_usd: 6001,
    bars_5m: [
      {
        timestamp: '2026-08-10T14:45:00Z',
        open_usd: 5996,
        high_usd: 5999,
        low_usd: 5995,
        close_usd: 5998,
        volume: 1_000,
      },
      {
        timestamp: '2026-08-10T14:50:00Z',
        open_usd: 5998,
        high_usd: 6004,
        low_usd: 5997,
        close_usd: 6003,
        volume: 1_500,
      },
      {
        timestamp: '2026-08-10T14:55:00Z',
        open_usd: 6002,
        high_usd: 6005,
        low_usd: 6000,
        close_usd: 6004,
        volume: 1_200,
      },
    ],
    ...overrides,
  };
}

test('latest line observes regime and lifecycle without creating or filtering a base signal', () => {
  const result = evaluate_junk_latest_line_entry({
    candidate: candidate({
      setup_type: 'breakout_retest',
      confirmation_bar_at: '2026-08-10T14:55:00Z',
      last_price_usd: 6004,
      vwap_usd: 6001,
      evidence_model: { heatmap: { assessment: 'confirm' } },
    }),
    gex_node_history: latestHistory(),
    market_context: latestMarketContext(),
    now_ms: NOW,
  });
  assert.equal(result.participate, true);
  assert.equal(result.classified_regime, 'breakout_retest');
  assert.equal(result.lifecycle_state, 'second_touch_observed');
  assert.deepEqual(result.reason_codes, ['base_v3_entry_shared_regime_lifecycle_observation_only']);
});

test('unconfirmed Heatmap and repeated touches remain diagnostics and do not veto the latest line', () => {
  const base = {
    candidate: candidate({
      setup_type: 'breakout_retest',
      confirmation_bar_at: '2026-08-10T14:55:00Z',
      evidence_model: { heatmap: { assessment: 'neutral' } },
    }),
    gex_node_history: latestHistory(),
    market_context: latestMarketContext(),
    now_ms: NOW,
  };
  const unconfirmed = evaluate_junk_latest_line_entry(base);
  assert.equal(unconfirmed.participate, true);
  assert.equal(unconfirmed.diagnostics.heatmap_assessment, 'neutral');

  const consumed = evaluate_junk_latest_line_entry({
    ...base,
    candidate: {
      ...base.candidate,
      evidence_model: { heatmap: { assessment: 'confirm' } },
    },
    market_context: latestMarketContext({
      bars_5m: [
        {
          timestamp: '2026-08-10T14:40:00Z',
          open_usd: 5999,
          high_usd: 6001,
          low_usd: 5998,
          close_usd: 5999,
          volume: 900,
        },
        ...latestMarketContext().bars_5m,
      ],
    }),
  });
  assert.equal(consumed.participate, true);
  assert.equal(consumed.lifecycle_state, 'repeated_touch_observed');
  assert.equal(consumed.diagnostics.node_touch_count, 3);
});

test('latest line records a node rejection without requiring positive Gamma or inward VWAP', () => {
  const bars = [
    {
      timestamp: '2026-08-10T14:50:00Z',
      open_usd: 6004,
      high_usd: 6007,
      low_usd: 6003,
      close_usd: 6006,
      volume: 1_000,
    },
    {
      timestamp: '2026-08-10T14:55:00Z',
      open_usd: 6008,
      high_usd: 6011,
      low_usd: 6005,
      close_usd: 6006,
      volume: 1_200,
    },
  ];
  const result = evaluate_junk_latest_line_entry({
    candidate: candidate({
      direction: 'bearish',
      setup_type: 'node_rejection',
      tested_node: { strike_usd: 6010, net_gex_usd: 1_500_000 },
      confirmation_bar_at: '2026-08-10T14:55:00Z',
      last_price_usd: 6006,
      vwap_usd: 6000,
      evidence_model: { heatmap: { assessment: 'confirm' } },
    }),
    gex_node_history: latestHistory(),
    market_context: { last_price_usd: 6006, vwap_usd: 6000, bars_5m: bars },
    now_ms: NOW,
  });
  assert.equal(result.participate, true);
  assert.equal(result.classified_regime, 'node_rejection');
  assert.equal(result.lifecycle_state, 'first_touch_observed');
});

test('fresh heatmap confirms only an exact ranked structure node regardless of GEX sign', () => {
  const result = evaluate_junk_heatmap_evidence({
    candidate: candidate(),
    heatmap_context: heatmap(),
    policy: { node_tolerance_points: 5, require_ranked_node_when_fresh: true },
    now_ms: NOW,
  });
  assert.equal(result.assessment, 'confirm');
  assert.equal(result.can_trigger_trade, false);
  assert.deepEqual(result.reason_codes, ['heatmap_ranked_structure_node_confirmed']);

  const opposite_sign = evaluate_junk_heatmap_evidence({
    candidate: candidate(),
    heatmap_context: heatmap({
      top_rows: [{ strike_usd: 6000, row_net_wall_gex_usd: -99_000_000 }],
    }),
    policy: { node_tolerance_points: 5, conflict_veto_enabled: true },
    now_ms: NOW,
  });
  assert.equal(opposite_sign.assessment, 'confirm');
  assert.equal(opposite_sign.can_veto_candidate, false);
  assert.deepEqual(opposite_sign.reason_codes, ['heatmap_ranked_structure_node_confirmed']);
});

test('fresh off-strike heatmap row stays context-only even with legacy veto flags', () => {
  const outside = heatmap({
    top_rows: [{ strike_usd: 6025, row_net_wall_gex_usd: -2_000_000 }],
  });
  const neutral = evaluate_junk_heatmap_evidence({
    candidate: candidate(),
    heatmap_context: outside,
    policy: { node_tolerance_points: 50 },
    now_ms: NOW,
  });
  assert.equal(neutral.assessment, 'neutral');
  assert.equal(neutral.can_veto_candidate, false);

  const required = apply_junk_v2_evidence({
    core_decision: candidate(),
    heatmap_context: outside,
    evidence_policy: { heatmap: { node_tolerance_points: 5, require_ranked_node_when_fresh: true } },
    flow_evaluation: { assessment: 'neutral', reason_codes: ['no_live_events'] },
    now_ms: NOW,
  });
  assert.equal(required.decision, 'trade');
  assert.equal(required.evidence_model.heatmap.can_veto_candidate, false);
  assert.equal(required.evidence_model.heatmap.assessment, 'neutral');
  assert.ok(!required.reason_codes.includes('heatmap_structure_conflict_veto'));
});

test('missing or degraded heatmap remains neutral and cannot create a trade', () => {
  const noCandidate = apply_junk_v2_evidence({
    core_decision: candidate({ decision: 'no_trade', action: 'hold' }),
    heatmap_context: null,
    flow_evaluation: { assessment: 'confirm', source_message_ids: ['m1', 'm2'] },
    now_ms: NOW,
  });
  assert.equal(noCandidate.decision, 'no_trade');
  assert.equal(noCandidate.evidence_model.automated_flow.can_trigger_trade, false);

  const degraded = apply_junk_v2_evidence({
    core_decision: candidate(),
    heatmap_context: heatmap({ state: 'degraded' }),
    flow_evaluation: { assessment: 'neutral' },
    now_ms: NOW,
  });
  assert.equal(degraded.decision, 'trade');
  assert.equal(degraded.evidence_model.heatmap.assessment, 'neutral');

  for (const top_rows of [null, []]) {
    const missingRows = apply_junk_v2_evidence({
      core_decision: candidate(),
      heatmap_context: heatmap({ top_rows }),
      flow_evaluation: { assessment: 'neutral' },
      evidence_policy: { heatmap: { require_ranked_node_when_fresh: true } },
      now_ms: NOW,
    });
    assert.equal(missingRows.decision, 'trade');
    assert.equal(missingRows.evidence_model.heatmap.assessment, 'neutral');
    assert.deepEqual(
      missingRows.evidence_model.heatmap.reason_codes,
      ['heatmap_ranked_rows_missing_neutral'],
    );
  }
});

test('quality-incomplete or SPY flow is forced neutral and cannot veto', () => {
  const incomplete = apply_junk_v2_evidence({
    core_decision: candidate(),
    heatmap_context: heatmap(),
    flow_evaluation: {
      assessment: 'conflict_veto',
      decision_evidence_ticker: 'spx',
      quality_complete: false,
      source_message_ids: ['x', 'y'],
    },
    now_ms: NOW,
  });
  assert.equal(incomplete.decision, 'trade');
  assert.equal(incomplete.evidence_model.automated_flow.assessment, 'neutral');
  assert.ok(incomplete.evidence_model.automated_flow.reason_codes.includes('flow_quality_incomplete_neutral'));

  const spy_only = apply_junk_v2_evidence({
    core_decision: candidate(),
    heatmap_context: heatmap(),
    flow_evaluation: {
      assessment: 'confirm',
      decision_evidence_ticker: 'spy',
      quality_complete: true,
      quality_rule: 'live_0dte_spx_large_otm_same_strike_sweep',
    },
    now_ms: NOW,
  });
  assert.equal(spy_only.evidence_model.automated_flow.assessment, 'neutral');
  assert.ok(spy_only.evidence_model.automated_flow.reason_codes.includes('flow_quality_incomplete_neutral'));
});

test('quality-complete SPX flow confirms but remains context-only on conflict by default', () => {
  const quality = {
    decision_evidence_ticker: 'spx',
    quality_complete: true,
    quality_rule: 'live_0dte_spx_large_otm_same_strike_sweep',
    candidate_spot_usd: 6000,
  };
  const confirmed = apply_junk_v2_evidence({
    core_decision: candidate(),
    heatmap_context: heatmap(),
    flow_evaluation: {
      assessment: 'confirm',
      ...quality,
      source_message_ids: ['a', 'b'],
      decision_source_message_ids: ['a', 'b'],
      reason_codes: ['spx_large_otm_same_strike_sweep_confirmed'],
    },
    now_ms: NOW,
  });
  assert.equal(confirmed.decision, 'trade');
  assert.equal(confirmed.strategy, 'junk_gex_nodes_v3');
  assert.equal(confirmed.model_version, 'junk_gex_evidence_v3');
  assert.ok(confirmed.reason_codes.includes('automated_flow_context_confirmed'));
  assert.deepEqual(confirmed.evidence_model.source_message_ids, ['a', 'b']);

  const vetoed = apply_junk_v2_evidence({
    core_decision: candidate(),
    heatmap_context: heatmap(),
    flow_evaluation: {
      assessment: 'conflict_veto',
      ...quality,
      source_message_ids: ['x', 'y'],
      reason_codes: ['spx_large_otm_same_strike_sweep_conflict_veto'],
    },
    now_ms: NOW,
  });
  assert.equal(vetoed.decision, 'trade');
  assert.ok(vetoed.reason_codes.includes('automated_flow_conflict_context_only'));
  assert.equal(vetoed.automated_flow_usage, 'confirmation_context_only');
  assert.equal(vetoed.evidence_model.automated_flow.can_veto_candidate, false);

  const legacy_veto_flag_is_ignored = apply_junk_v2_evidence({
    core_decision: candidate(),
    heatmap_context: heatmap(),
    flow_evaluation: {
      assessment: 'conflict_veto',
      ...quality,
      source_message_ids: ['x', 'y'],
    },
    evidence_policy: { automated_flow_alert: { conflict_veto_enabled: true } },
    now_ms: NOW,
  });
  assert.equal(legacy_veto_flag_is_ignored.decision, 'trade');
  assert.equal(legacy_veto_flag_is_ignored.automated_flow_usage, 'confirmation_context_only');
  assert.equal(legacy_veto_flag_is_ignored.evidence_model.automated_flow.can_veto_candidate, false);
  assert.ok(legacy_veto_flag_is_ignored.reason_codes.includes('automated_flow_conflict_context_only'));

  const no_candidate = apply_junk_v2_evidence({
    core_decision: candidate({ decision: 'no_trade', action: 'hold' }),
    heatmap_context: heatmap(),
    flow_evaluation: { assessment: 'confirm', ...quality },
    now_ms: NOW,
  });
  assert.equal(no_candidate.decision, 'no_trade');
  assert.equal(no_candidate.evidence_model.automated_flow.can_trigger_trade, false);
});
