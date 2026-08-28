import { evaluate_junk_gex_strategy, normalize_gex_snapshot } from './junk-gex-strategy.mjs';
import { NIGHTWATCH_FIXED_SAMPLE_MAX_AGE_MS } from './junk-gex-freshness.mjs';

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

function median(values) {
  const usable = (Array.isArray(values) ? values : [])
    .map(finite_number)
    .filter((value) => value !== null)
    .sort((left, right) => left - right);
  if (usable.length === 0) return null;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 === 1
    ? usable[middle]
    : (usable[middle - 1] + usable[middle]) / 2;
}

function normalized_history(gex_node_history, session_date_et, now_ms) {
  const by_timestamp = new Map();
  for (const raw of Array.isArray(gex_node_history) ? gex_node_history : []) {
    const snapshot = normalize_gex_snapshot(raw);
    const at_ms = timestamp_ms(snapshot.snapshot_at);
    if (
      at_ms === null
      || at_ms > Number(now_ms) + 5_000
      || snapshot.session_date_et !== session_date_et
      || snapshot.nodes.length === 0
    ) continue;
    by_timestamp.set(at_ms, snapshot);
  }
  return [...by_timestamp.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, snapshot]) => snapshot);
}

function structure_overlap(left, right) {
  const left_set = new Set((left?.nodes || []).map((node) => Number(node.strike_usd)));
  const right_set = new Set((right?.nodes || []).map((node) => Number(node.strike_usd)));
  const union = new Set([...left_set, ...right_set]);
  if (union.size === 0) return null;
  const intersection_count = [...left_set].filter((strike) => right_set.has(strike)).length;
  return intersection_count / union.size;
}

const LATEST_LINE_DEFAULTS = Object.freeze({
  entry_profile: 'latest_regime_lifecycle_v1',
  node_sample_window: 3,
});

// Regime/lifecycle fields are retained for replay and review only. They must
// not veto a sourced base-v3 JUNKMAN entry unless a future, attributable rule
// explicitly defines such a gate.
export function evaluate_junk_latest_line_entry({
  candidate,
  gex_node_history,
  market_context,
  policy = {},
  now_ms = Date.now(),
} = {}) {
  const resolved = { ...LATEST_LINE_DEFAULTS, ...(policy || {}) };
  const reasons = [];
  const tested_strike = finite_number(candidate?.tested_node?.strike_usd);
  const tested_sign = Math.sign(finite_number(candidate?.tested_node?.net_gex_usd) ?? 0);
  const setup_type = String(candidate?.setup_type || candidate?.regime || '').trim();
  const heatmap_assessment = candidate?.evidence_model?.heatmap?.assessment || null;
  const bars = (Array.isArray(market_context?.bars_5m) ? market_context.bars_5m : [])
    .filter((bar) => timestamp_ms(bar?.timestamp) !== null)
    .sort((left, right) => timestamp_ms(left.timestamp) - timestamp_ms(right.timestamp));
  const vwap_usd = finite_number(market_context?.vwap_usd ?? candidate?.vwap_usd);
  const last_price_usd = finite_number(market_context?.last_price_usd ?? candidate?.last_price_usd);

  if (candidate?.decision !== 'trade') reasons.push('latest_line_requires_base_trade');

  const history = normalized_history(gex_node_history, candidate?.session_date_et, now_ms);
  const sample_window = history.slice(-Math.max(2, Number(resolved.node_sample_window) || 3));
  const node_samples = tested_strike === null ? [] : sample_window.map((snapshot) => {
    const node = snapshot.nodes.find((row) => (
      Math.abs(Number(row.strike_usd) - tested_strike) <= 1e-6
      && Math.sign(Number(row.net_gex_usd)) === tested_sign
    ));
    return node ? {
      snapshot_at: snapshot.snapshot_at,
      net_gex_usd: node.net_gex_usd,
    } : null;
  }).filter(Boolean);
  const node_present_in_latest_sample = Boolean(
    sample_window.at(-1)?.nodes.some((row) => (
      Math.abs(Number(row.strike_usd) - tested_strike) <= 1e-6
      && Math.sign(Number(row.net_gex_usd)) === tested_sign
    )),
  );
  const first_strength = Math.abs(finite_number(node_samples[0]?.net_gex_usd) ?? 0);
  const last_strength = Math.abs(finite_number(node_samples.at(-1)?.net_gex_usd) ?? 0);
  const node_strength_ratio = first_strength > 0 ? last_strength / first_strength : null;

  const overlap_ratio = sample_window.length >= 2
    ? structure_overlap(sample_window.at(-2), sample_window.at(-1))
    : null;

  const node_touch_count = tested_strike === null ? 0 : bars.filter((bar) => {
    const low = finite_number(bar?.low_usd);
    const high = finite_number(bar?.high_usd);
    return low !== null && high !== null && low <= tested_strike && high >= tested_strike;
  }).length;

  const confirmation_at = timestamp_ms(candidate?.confirmation_bar_at);
  const confirmation_index = confirmation_at === null
    ? bars.length - 1
    : bars.findIndex((bar) => timestamp_ms(bar.timestamp) === confirmation_at);
  const confirmation_bar = confirmation_index >= 0 ? bars[confirmation_index] : null;
  const confirmation_volume = finite_number(confirmation_bar?.volume);
  const prior_volume_median = median(
    bars.slice(Math.max(0, confirmation_index - 5), Math.max(0, confirmation_index))
      .map((bar) => bar?.volume),
  );
  const relative_confirmation_volume = confirmation_volume !== null && prior_volume_median > 0
    ? confirmation_volume / prior_volume_median
    : null;
  let classified_regime = null;
  if (setup_type === 'breakout_retest') {
    classified_regime = 'breakout_retest';
  } else if (setup_type === 'node_rejection') {
    classified_regime = 'node_rejection';
  }

  const participate = reasons.length === 0;
  return {
    kind: 'junk_experiment_entry_participation',
    version: 1,
    entry_profile: resolved.entry_profile,
    participate,
    decision: participate ? 'trade' : 'no_trade',
    classified_regime,
    lifecycle_state: node_touch_count <= 1 ? 'first_touch_observed'
      : (node_touch_count === 2 ? 'second_touch_observed' : 'repeated_touch_observed'),
    reason_codes: participate
      ? ['base_v3_entry_shared_regime_lifecycle_observation_only']
      : unique_strings(reasons),
    diagnostics: {
      heatmap_assessment,
      node_sample_count: node_samples.length,
      node_present_in_latest_sample,
      node_strength_ratio: node_strength_ratio === null ? null : Number(node_strength_ratio.toFixed(4)),
      structure_overlap_ratio: overlap_ratio === null ? null : Number(overlap_ratio.toFixed(4)),
      node_touch_count,
      relative_confirmation_volume: relative_confirmation_volume === null
        ? null
        : Number(relative_confirmation_volume.toFixed(4)),
      vwap_usd,
      last_price_usd,
    },
  };
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
  const max_age_ms = Math.max(
    1_000,
    finite_number(policy.max_age_ms) ?? NIGHTWATCH_FIXED_SAMPLE_MAX_AGE_MS,
  );
  if (generated_ms === null) return { ...base, reason_codes: ['heatmap_timestamp_invalid_neutral'] };
  const age_ms = Number(now_ms) - generated_ms;
  if (age_ms < -5_000) return { ...base, reason_codes: ['heatmap_from_future_neutral'] };
  if (age_ms > max_age_ms) return { ...base, reason_codes: ['heatmap_stale_neutral'] };

  if (!Array.isArray(heatmap_context.top_rows) || heatmap_context.top_rows.length === 0) {
    return { ...base, reason_codes: ['heatmap_ranked_rows_missing_neutral'] };
  }
  const row = nearest_heatmap_row(heatmap_context.top_rows, candidate.tested_node.strike_usd);
  if (!row) {
    return { ...base, reason_codes: ['heatmap_tested_node_not_ranked_neutral'] };
  }
  const distance = Math.abs(Number(row.strike_usd) - Number(candidate.tested_node.strike_usd));
  const with_row = {
    ...base,
    nearest_tested_node_row: row,
    node_distance_points: Number(distance.toFixed(4)),
  };
  if (distance > 1e-6) {
    return { ...with_row, reason_codes: ['heatmap_tested_node_not_ranked_neutral'] };
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
    usage: 'confirmation_context_only',
    dependency: false,
    can_trigger_trade: false,
    can_veto_candidate: false,
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
  const effective_flow = {
    ...flow,
    usage: 'confirmation_context_only',
    can_veto_candidate: false,
  };
  const vetoes = [];
  const confirmations = [];
  if (core.decision === 'trade' && heatmap.assessment === 'confirm') confirmations.push('heatmap_structure_confirmed');
  if (core.decision === 'trade' && flow.assessment === 'confirm') confirmations.push('automated_flow_context_confirmed');
  const context_only_reasons = [];
  if (
    core.decision === 'trade'
    && flow.assessment === 'conflict_veto'
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
    automated_flow_usage: 'confirmation_context_only',
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
