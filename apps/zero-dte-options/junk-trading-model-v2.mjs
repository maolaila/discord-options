import { evaluate_junk_gex_strategy } from './junk-gex-strategy.mjs';

const MODEL_ID = 'junk_gex_evidence_v3';

function finite_number(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp_ms(value) {
  const text = String(value || '').trim().replace(/\.(\d{3})\d+Z$/, '.$1Z');
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonical_direction(value) {
  const direction = String(value || '').trim().toLowerCase();
  if (['bull', 'bullish', 'call', 'up'].includes(direction)) return 'bullish';
  if (['bear', 'bearish', 'put', 'down'].includes(direction)) return 'bearish';
  return null;
}

function unique_strings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))];
}

function nearest_heatmap_row(rows, strike) {
  const target = finite_number(strike);
  if (target === null || !Array.isArray(rows)) return null;
  return [...rows]
    .filter((row) => finite_number(row?.strike_usd) !== null)
    .sort((left, right) => (
      Math.abs(Number(left.strike_usd) - target) - Math.abs(Number(right.strike_usd) - target)
    ))[0] || null;
}

export function evaluate_junk_heatmap_evidence({
  heatmap_context,
  candidate,
  policy = {},
  now_ms = Date.now(),
} = {}) {
  const enabled = policy.enabled !== false;
  const base = {
    source: 'nightwatch_heatmap_snapshot',
    enabled,
    assessment: 'neutral',
    can_trigger_trade: false,
    can_veto_candidate: false,
    require_ranked_node_when_fresh: policy.require_ranked_node_when_fresh === true,
    state: heatmap_context?.state || null,
    generated_at: heatmap_context?.generated_at || null,
    session_date_et: heatmap_context?.session_date_et || null,
    nearest_tested_node_row: null,
    node_distance_points: null,
    strength_ratio: null,
    reason_codes: [],
  };
  if (!enabled) return { ...base, reason_codes: ['heatmap_evidence_disabled'] };
  if (!candidate || candidate.decision !== 'trade' || !candidate.tested_node) {
    return { ...base, reason_codes: ['no_trade_candidate_for_heatmap_evaluation'] };
  }
  if (!heatmap_context) return { ...base, reason_codes: ['heatmap_missing_neutral'] };
  if (String(heatmap_context.state || '').toLowerCase() !== 'fresh') {
    return { ...base, reason_codes: [`heatmap_state_neutral:${heatmap_context.state || 'missing'}`] };
  }
  if (
    candidate.session_date_et
    && heatmap_context.session_date_et
    && candidate.session_date_et !== heatmap_context.session_date_et
  ) {
    return { ...base, reason_codes: ['heatmap_cross_session_neutral'] };
  }

  const generated_ms = timestamp_ms(heatmap_context.generated_at);
  const max_age_ms = Math.max(1_000, finite_number(policy.max_age_ms) ?? 120_000);
  if (generated_ms === null) return { ...base, reason_codes: ['heatmap_timestamp_invalid_neutral'] };
  const age_ms = Number(now_ms) - generated_ms;
  if (age_ms < -5_000) return { ...base, reason_codes: ['heatmap_from_future_neutral'] };
  if (age_ms > max_age_ms) return { ...base, reason_codes: ['heatmap_stale_neutral'] };

  if (!Array.isArray(heatmap_context.top_rows) || heatmap_context.top_rows.length === 0) {
    return { ...base, reason_codes: ['heatmap_ranked_rows_missing_neutral'] };
  }
  const row = nearest_heatmap_row(heatmap_context.top_rows, candidate.tested_node.strike_usd);
  if (!row) {
    if (policy.require_ranked_node_when_fresh === true) {
      return {
        ...base,
        assessment: 'conflict_veto',
        can_veto_candidate: true,
        reason_codes: ['heatmap_fresh_ranked_node_required_veto'],
      };
    }
    return { ...base, reason_codes: ['heatmap_tested_node_not_ranked_neutral'] };
  }
  const distance = Math.abs(Number(row.strike_usd) - Number(candidate.tested_node.strike_usd));
  const tolerance = Math.max(0, finite_number(policy.node_tolerance_points) ?? 5);
  const with_row = {
    ...base,
    nearest_tested_node_row: row,
    node_distance_points: Number(distance.toFixed(4)),
  };
  if (distance > tolerance) {
    if (policy.require_ranked_node_when_fresh === true) {
      return {
        ...with_row,
        assessment: 'conflict_veto',
        can_veto_candidate: true,
        reason_codes: ['heatmap_fresh_ranked_node_required_veto'],
      };
    }
    return { ...with_row, reason_codes: ['heatmap_tested_node_outside_tolerance_neutral'] };
  }
  return {
    ...with_row,
    assessment: 'confirm',
    reason_codes: ['heatmap_ranked_structure_node_confirmed'],
  };
}

function normalize_flow_evaluation(flow_evaluation, candidate) {
  const assessment_text = String(
    flow_evaluation?.assessment
      || flow_evaluation?.decision
      || flow_evaluation?.candidate_assessment
      || 'neutral',
  ).toLowerCase();
  const requested_assessment = assessment_text.includes('conflict') || assessment_text.includes('veto')
    ? 'conflict_veto'
    : (assessment_text.includes('confirm') ? 'confirm' : 'neutral');
  const decision_evidence_ticker = String(
    flow_evaluation?.decision_evidence_ticker || '',
  ).trim().toLowerCase() || null;
  const required_quality_rule = 'live_0dte_spx_large_otm_same_strike_sweep';
  const quality_complete = flow_evaluation?.quality_complete === true
    && decision_evidence_ticker === 'spx'
    && flow_evaluation?.quality_rule === required_quality_rule;
  const assessment = requested_assessment === 'neutral' || quality_complete
    ? requested_assessment
    : 'neutral';
  const message_ids = unique_strings([
    ...(flow_evaluation?.source_message_ids || []),
    ...(flow_evaluation?.supportive_message_ids || []),
    ...(flow_evaluation?.opposing_message_ids || []),
  ]);
  const event_ids = unique_strings([
    ...(flow_evaluation?.source_event_ids || []),
    ...(flow_evaluation?.supportive_event_ids || []),
    ...(flow_evaluation?.opposing_event_ids || []),
  ]);
  const reason_codes = unique_strings(flow_evaluation?.reason_codes || []);
  if (requested_assessment !== 'neutral' && !quality_complete) {
    reason_codes.push('flow_quality_incomplete_neutral');
  }
  return {
    source: 'discord_nightwatch_0dte_flow_alert',
    usage: 'confirm_or_conflict_veto_only',
    dependency: false,
    can_trigger_trade: false,
    can_veto_candidate: assessment === 'conflict_veto',
    candidate_direction: canonical_direction(candidate?.direction),
    assessment,
    requested_assessment,
    decision_evidence_ticker,
    quality_rule: flow_evaluation?.quality_rule || required_quality_rule,
    quality_complete: assessment !== 'neutral' && quality_complete,
    candidate_spot_usd: finite_number(flow_evaluation?.candidate_spot_usd),
    source_message_ids: message_ids,
    source_event_ids: event_ids,
    decision_source_message_ids: unique_strings(
      flow_evaluation?.decision_source_message_ids || [],
    ),
    decision_source_event_ids: unique_strings(
      flow_evaluation?.decision_source_event_ids || [],
    ),
    reason_codes: unique_strings(reason_codes),
    context: flow_evaluation || null,
  };
}

export function apply_junk_v2_evidence({
  core_decision,
  heatmap_context,
  flow_evaluation,
  evidence_policy = {},
  now_ms = Date.now(),
} = {}) {
  const core = core_decision || {
    decision: 'no_trade',
    action: 'hold',
    reason_codes: ['missing_core_decision'],
  };
  const heatmap = evaluate_junk_heatmap_evidence({
    heatmap_context,
    candidate: core,
    policy: evidence_policy.heatmap || {},
    now_ms,
  });
  const flow = normalize_flow_evaluation(flow_evaluation, core);
  const flow_conflict_veto_enabled = evidence_policy?.automated_flow_alert?.conflict_veto_enabled === true;
  const effective_flow = {
    ...flow,
    usage: flow_conflict_veto_enabled
      ? 'confirm_or_conflict_veto_only'
      : 'confirmation_context_only',
    can_veto_candidate: flow_conflict_veto_enabled && flow.can_veto_candidate,
  };
  const vetoes = [];
  if (core.decision === 'trade' && heatmap.assessment === 'conflict_veto') {
    vetoes.push('heatmap_structure_conflict_veto');
  }
  if (
    core.decision === 'trade'
    && flow.assessment === 'conflict_veto'
    && flow_conflict_veto_enabled
  ) {
    vetoes.push('automated_flow_conflict_veto');
  }
  const confirmations = [];
  if (core.decision === 'trade' && heatmap.assessment === 'confirm') confirmations.push('heatmap_structure_confirmed');
  if (core.decision === 'trade' && flow.assessment === 'confirm') confirmations.push('automated_flow_context_confirmed');
  const context_only_reasons = [];
  if (
    core.decision === 'trade'
    && flow.assessment === 'conflict_veto'
    && !flow_conflict_veto_enabled
  ) {
    context_only_reasons.push('automated_flow_conflict_context_only');
  }

  const blocked = vetoes.length > 0;
  const reason_codes = unique_strings([
    ...(core.reason_codes || []),
    ...confirmations,
    ...context_only_reasons,
    ...vetoes,
  ]);
  return {
    ...core,
    strategy: 'junk_gex_nodes_v3',
    model_version: MODEL_ID,
    flow_dependency: 'none',
    automated_flow_usage: flow_conflict_veto_enabled
      ? 'confirm_or_conflict_veto_only'
      : 'confirmation_context_only',
    manual_discord_flow_allowed: false,
    decision: blocked ? 'no_trade' : core.decision,
    action: blocked ? 'hold' : core.action,
    reason_codes,
    evidence_model: {
      model_id: MODEL_ID,
      primary_trigger: 'gex_structure_plus_moomoo_price_confirmation',
      heatmap,
      automated_flow: effective_flow,
      contract_confirmation: 'deferred_to_moomoo_execution_gate',
      confirmations,
      vetoes,
      source_message_ids: effective_flow.source_message_ids,
      source_event_ids: effective_flow.source_event_ids,
    },
  };
}

export function evaluate_junk_trading_model_v2({
  gex_snapshot,
  gex_node_history,
  market_context,
  heatmap_context,
  flow_evaluation,
  policy,
  evidence_policy,
  now_ms = Date.now(),
} = {}) {
  const core_decision = evaluate_junk_gex_strategy({
    gex_snapshot,
    gex_node_history,
    market_context,
    policy,
    now_ms,
  });
  return apply_junk_v2_evidence({
    core_decision,
    heatmap_context,
    flow_evaluation,
    evidence_policy,
    now_ms,
  });
}

// Compatibility aliases keep existing imports and archived plan readers stable
// while the production decision contract advances to v3.
export const apply_junk_v3_evidence = apply_junk_v2_evidence;
export const evaluate_junk_trading_model_v3 = evaluate_junk_trading_model_v2;
export { MODEL_ID as JUNK_TRADING_MODEL_V2, MODEL_ID as JUNK_TRADING_MODEL_V3 };
