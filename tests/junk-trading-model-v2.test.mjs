import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apply_junk_v2_evidence,
  evaluate_junk_heatmap_evidence,
} from '../apps/zero-dte-options/junk-trading-model-v2.mjs';

const NOW = Date.parse('2026-08-10T15:00:30Z');

function candidate(overrides = {}) {
  return {
    strategy: 'junk_gex_nodes_v3',
    decision: 'trade',
    action: 'open_long_option',
    direction: 'bullish',
    session_date_et: '2026-08-10',
    reason_codes: ['gex_node_confirmed', 'vwap_confirmed'],
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

test('fresh ranked heatmap node confirms by proximity regardless of GEX sign', () => {
  const result = evaluate_junk_heatmap_evidence({
    candidate: candidate(),
    heatmap_context: heatmap(),
    policy: { node_tolerance_points: 5 },
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

test('fresh heatmap can veto only when policy requires a nearby ranked node', () => {
  const outside = heatmap({
    top_rows: [{ strike_usd: 6025, row_net_wall_gex_usd: -2_000_000 }],
  });
  const neutral = evaluate_junk_heatmap_evidence({
    candidate: candidate(),
    heatmap_context: outside,
    policy: { node_tolerance_points: 5 },
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
  assert.equal(required.decision, 'no_trade');
  assert.equal(required.evidence_model.heatmap.can_veto_candidate, true);
  assert.ok(required.reason_codes.includes('heatmap_structure_conflict_veto'));
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

  const explicitly_vetoed = apply_junk_v2_evidence({
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
  assert.equal(explicitly_vetoed.decision, 'no_trade');
  assert.ok(explicitly_vetoed.reason_codes.includes('automated_flow_conflict_veto'));

  const no_candidate = apply_junk_v2_evidence({
    core_decision: candidate({ decision: 'no_trade', action: 'hold' }),
    heatmap_context: heatmap(),
    flow_evaluation: { assessment: 'confirm', ...quality },
    now_ms: NOW,
  });
  assert.equal(no_candidate.decision, 'no_trade');
  assert.equal(no_candidate.evidence_model.automated_flow.can_trigger_trade, false);
});
