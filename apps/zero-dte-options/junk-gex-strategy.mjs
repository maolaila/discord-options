import { createHash } from 'node:crypto';
import { JUNK_GEX_MAX_AGE_MS } from './junk-gex-freshness.mjs';

const MINUTE_MS = 60_000;
const FIVE_MINUTE_MS = 5 * MINUTE_MS;
const NEW_YORK_TIME_ZONE = 'America/New_York';

export const DEFAULT_JUNK_GEX_POLICY = Object.freeze({
  execution_environment: 'simulate_only',
  real_trading_allowed: false,
  allowed_snapshot_states: Object.freeze(['fresh']),
  max_snapshot_age_ms: JUNK_GEX_MAX_AGE_MS,
  max_nodes: 12,
  node_tolerance_points: 1.5,
  min_displacement_points: 1,
  min_body_points: 1,
  stop_buffer_points: 1,
  min_reward_risk_ratio: 0.75,
  max_entry_drift_points: 3,
  closed_bar_interval_ms: FIVE_MINUTE_MS,
  closed_bar_interval_tolerance_ms: 1_000,
  max_closed_bar_age_ms: 90_000,
  min_gex_node_history_samples: 3,
  preferred_gex_node_history_bar_coverage: 3,
  require_gex_node_history_bar_coverage: true,
  gex_node_history_strike_tolerance_points: 0.5,
  require_vwap_confirmation: true,
  require_volume_confirmation: true,
  min_impulse_volume_ratio: 1,
  magnet_dead_zone_points: 1.5,
  allow_positive_gamma_single_leg_mean_reversion: false,
  option_expiry_days: 0,
  option_strike_step_points: 5,
  option_strike_offset_points: 5,
});

function finite_number(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rounded(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function timestamp_ms(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function iso_timestamp(value) {
  const parsed = timestamp_ms(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function date_in_new_york(value) {
  const parsed = timestamp_ms(value);
  if (parsed === null) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NEW_YORK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(parsed));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function source_payload(gex_snapshot) {
  if (gex_snapshot?.data && typeof gex_snapshot.data === 'object') return gex_snapshot.data;
  return gex_snapshot || {};
}

function normalize_strike(strike) {
  const normalized = {
    strike_usd: finite_number(strike?.strike_usd),
    net_gex_usd: finite_number(strike?.net_gex_usd),
    call_gex_usd: finite_number(strike?.call_gex_usd),
    put_gex_usd: finite_number(strike?.put_gex_usd),
    node_type: strike?.node_type ? String(strike.node_type) : null,
  };
  return Number.isFinite(normalized.strike_usd) && Number.isFinite(normalized.net_gex_usd)
    ? normalized
    : null;
}

function structural_node_type(node) {
  return String(node?.node_type || '').trim().toLowerCase();
}

function is_gamma_flip_node(node) {
  const type = structural_node_type(node);
  return type.includes('gamma_flip') || type.split(/[^a-z]+/).includes('flip');
}

function is_wall_node(node) {
  const type = structural_node_type(node);
  return type.includes('call_wall') || type.includes('put_wall') || type.split(/[^a-z]+/).includes('wall');
}

function is_magnet_node(node) {
  const type = structural_node_type(node);
  return type.includes('magnet') || type.split(/[^a-z]+/).includes('mag');
}

function is_named_structural_node(node) {
  const tokens = structural_node_type(node).split(/[^a-z]+/);
  return is_gamma_flip_node(node)
    || is_wall_node(node)
    || is_magnet_node(node)
    || ['res', 'resistance', 'sup', 'support', 'acc', 'acceleration']
      .some((token) => tokens.includes(token));
}

function strongest_by(nodes, field) {
  return nodes
    .filter((node) => Number.isFinite(node[field]))
    .sort((left, right) => Math.abs(right[field]) - Math.abs(left[field]))[0] || null;
}

function select_nodes({ nodes, spot_usd, call_wall_usd, put_wall_usd, max_nodes }) {
  const limit = Math.max(2, Number(max_nodes) || DEFAULT_JUNK_GEX_POLICY.max_nodes);
  const mandatory = new Map();
  const keep = (node) => {
    if (node) mandatory.set(node.strike_usd, node);
  };
  const by_strength = (list) => [...list]
    .sort((left, right) => Math.abs(right.net_gex_usd) - Math.abs(left.net_gex_usd));

  if (Number.isFinite(spot_usd)) {
    for (const node of by_strength(nodes.filter((candidate) => candidate.strike_usd < spot_usd)).slice(0, 2)) {
      keep(node);
    }
    for (const node of by_strength(nodes.filter((candidate) => candidate.strike_usd > spot_usd)).slice(0, 2)) {
      keep(node);
    }
    keep(nodes.find((candidate) => candidate.strike_usd === spot_usd) || null);
  }

  for (const node of nodes) {
    const type = String(node.node_type || '').toLowerCase();
    if (type.includes('call_wall') || type.includes('put_wall')) keep(node);
    if (is_named_structural_node(node)) keep(node);
    if (Number.isFinite(call_wall_usd) && node.strike_usd === call_wall_usd) keep(node);
    if (Number.isFinite(put_wall_usd) && node.strike_usd === put_wall_usd) keep(node);
  }
  keep(strongest_by(nodes, 'call_gex_usd'));
  keep(strongest_by(nodes, 'put_gex_usd'));

  for (const node of by_strength(nodes)) {
    if (mandatory.size >= limit) break;
    keep(node);
  }

  // Mandatory nodes may exceed a bad max_nodes setting. Retaining both sides
  // and both directional walls is safer than silently deleting structure.
  return [...mandatory.values()].sort((left, right) => left.strike_usd - right.strike_usd);
}

function normalize_bar(bar) {
  const timestamp = iso_timestamp(bar?.timestamp ?? bar?.minute_start_at ?? bar?.time);
  const normalized = {
    timestamp,
    open_usd: finite_number(bar?.open_usd),
    high_usd: finite_number(bar?.high_usd),
    low_usd: finite_number(bar?.low_usd),
    close_usd: finite_number(bar?.close_usd),
    volume: finite_number(bar?.volume),
  };
  if (!timestamp || ![normalized.open_usd, normalized.high_usd, normalized.low_usd, normalized.close_usd].every(Number.isFinite)) return null;
  if (normalized.volume !== null && normalized.volume < 0) return null;
  if (
    normalized.high_usd < Math.max(normalized.open_usd, normalized.close_usd)
    || normalized.low_usd > Math.min(normalized.open_usd, normalized.close_usd)
    || normalized.high_usd < normalized.low_usd
  ) return null;
  return normalized;
}

export function normalize_gex_snapshot(gex_snapshot, max_nodes = DEFAULT_JUNK_GEX_POLICY.max_nodes) {
  const source = source_payload(gex_snapshot);
  const summary = source.summary && typeof source.summary === 'object' ? source.summary : source;
  const spot_usd = finite_number(source.spot_usd);
  const call_wall_usd = finite_number(summary.call_wall_strike_usd ?? summary.call_wall_usd);
  const put_wall_usd = finite_number(summary.put_wall_strike_usd ?? summary.put_wall_usd);
  const gamma_flip_usd = finite_number(summary.gamma_flip_usd ?? summary.gamma_flip_strike_usd);
  const raw_strikes = Array.isArray(source.strikes)
    ? source.strikes
    : (Array.isArray(source.nodes) ? source.nodes : []);
  const all_nodes = raw_strikes.map(normalize_strike).filter(Boolean);
  if (Number.isFinite(gamma_flip_usd)) {
    const existing_index = all_nodes.findIndex((node) => Math.abs(node.strike_usd - gamma_flip_usd) <= 0.0001);
    if (existing_index >= 0) {
      const existing = all_nodes[existing_index];
      all_nodes[existing_index] = {
        ...existing,
        node_type: is_gamma_flip_node(existing)
          ? existing.node_type
          : `${existing.node_type || 'gex_node'}|gamma_flip`,
      };
    } else {
      all_nodes.push({
        strike_usd: gamma_flip_usd,
        net_gex_usd: 0,
        call_gex_usd: null,
        put_gex_usd: null,
        node_type: 'gamma_flip',
      });
    }
  }
  for (const [wall_usd, wall_type] of [[call_wall_usd, 'call_wall'], [put_wall_usd, 'put_wall']]) {
    if (!Number.isFinite(wall_usd)) continue;
    const index = all_nodes.findIndex((node) => Math.abs(node.strike_usd - wall_usd) <= 0.0001);
    if (index < 0) continue;
    const existing = all_nodes[index];
    if (!structural_node_type(existing).includes(wall_type)) {
      all_nodes[index] = {
        ...existing,
        node_type: `${existing.node_type || 'gex_node'}|${wall_type}`,
      };
    }
  }
  const nodes = select_nodes({
    nodes: all_nodes,
    spot_usd,
    call_wall_usd,
    put_wall_usd,
    max_nodes,
  });

  return {
    ticker: source.ticker ? String(source.ticker).toUpperCase() : null,
    snapshot_at: iso_timestamp(source.snapshot_at),
    session_date_et: source.session_date_et || null,
    state: source.state || null,
    spot_usd,
    total_gex_usd: finite_number(summary.total_gex_usd),
    call_wall_usd,
    put_wall_usd,
    gamma_flip_usd,
    nodes,
  };
}

function merged_policy(policy) {
  const merged = { ...DEFAULT_JUNK_GEX_POLICY, ...(policy || {}) };
  if (merged.execution_environment !== 'simulate_only' || merged.real_trading_allowed !== false) {
    throw new Error('junk GEX strategy is restricted to simulate_only');
  }
  const nonnegative = [
    'max_entry_drift_points',
    'closed_bar_interval_tolerance_ms',
    'max_closed_bar_age_ms',
    'gex_node_history_strike_tolerance_points',
    'min_impulse_volume_ratio',
    'magnet_dead_zone_points',
  ];
  const positive = [
    'closed_bar_interval_ms',
    'min_gex_node_history_samples',
    'preferred_gex_node_history_bar_coverage',
    'option_strike_step_points',
  ];
  for (const key of nonnegative) {
    if (!Number.isFinite(Number(merged[key])) || Number(merged[key]) < 0) {
      throw new TypeError(`${key} must be a non-negative number`);
    }
  }
  for (const key of positive) {
    if (!Number.isFinite(Number(merged[key])) || Number(merged[key]) <= 0) {
      throw new TypeError(`${key} must be a positive number`);
    }
  }
  return merged;
}

function base_result(snapshot, market_context, policy) {
  return {
    business_line: 'zero-dte-options',
    strategy: 'junk_gex_nodes_v3',
    execution_environment: policy.execution_environment,
    real_trading_allowed: false,
    flow_dependency: 'none',
    ticker: snapshot.ticker,
    snapshot_at: snapshot.snapshot_at,
    session_date_et: snapshot.session_date_et,
    snapshot_state: snapshot.state,
    spot_usd: snapshot.spot_usd,
    total_gex_usd: snapshot.total_gex_usd,
    gamma_flip_usd: snapshot.gamma_flip_usd,
    call_wall_usd: snapshot.call_wall_usd,
    put_wall_usd: snapshot.put_wall_usd,
    last_price_usd: finite_number(market_context?.last_price_usd),
    vwap_usd: finite_number(market_context?.vwap_usd),
    nodes: snapshot.nodes,
  };
}

function response_meta_freshness_seconds(gex_snapshot) {
  return finite_number(gex_snapshot?._meta?.data_freshness_seconds);
}

function no_trade(base, reason_codes) {
  return {
    ...base,
    decision: 'no_trade',
    action: 'hold',
    reason_codes: [...new Set(reason_codes)],
  };
}

function validate_signal_bars(raw_bars, snapshot, now_ms, policy) {
  if (!Array.isArray(raw_bars) || raw_bars.length < 3) {
    return { bars: [], reason_codes: ['insufficient_closed_confirmation_bars'] };
  }
  const selected = raw_bars.slice(-3);
  const bars = selected.map(normalize_bar);
  const reason_codes = [];
  if (bars.some((bar) => !bar)) return { bars: [], reason_codes: ['invalid_closed_confirmation_bar'] };
  if (policy.require_volume_confirmation && bars.some((bar) => !Number.isFinite(bar.volume))) {
    reason_codes.push('missing_closed_bar_volume');
  }

  const interval = Number(policy.closed_bar_interval_ms);
  const tolerance = Number(policy.closed_bar_interval_tolerance_ms);
  for (let index = 1; index < bars.length; index += 1) {
    const gap = timestamp_ms(bars[index].timestamp) - timestamp_ms(bars[index - 1].timestamp);
    if (Math.abs(gap - interval) > tolerance) {
      reason_codes.push('closed_confirmation_bars_not_continuous');
      break;
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(snapshot.session_date_et || ''))) {
    reason_codes.push('missing_or_invalid_session_date_et');
  } else if (bars.some((bar) => date_in_new_york(bar.timestamp) !== snapshot.session_date_et)) {
    reason_codes.push('closed_confirmation_bars_cross_et_session');
  }

  const latest_start_ms = timestamp_ms(bars.at(-1).timestamp);
  const latest_end_ms = latest_start_ms + interval;
  if (latest_end_ms > Number(now_ms) + tolerance) {
    reason_codes.push('latest_confirmation_bar_not_closed');
  } else if ((Number(now_ms) - latest_end_ms) > Number(policy.max_closed_bar_age_ms)) {
    reason_codes.push('closed_confirmation_bars_stale');
  }
  return { bars, reason_codes };
}

function vwap_confirms(direction, close_usd, vwap_usd, policy) {
  if (!policy.require_vwap_confirmation) return true;
  if (!Number.isFinite(vwap_usd)) return false;
  return direction === 'bullish' ? close_usd > vwap_usd : close_usd < vwap_usd;
}

function volume_confirms(current_bar, prior_bar, policy) {
  if (!policy.require_volume_confirmation) return true;
  if (!Number.isFinite(current_bar?.volume) || !Number.isFinite(prior_bar?.volume)) return false;
  if (prior_bar.volume <= 0) return current_bar.volume > 0;
  return current_bar.volume >= prior_bar.volume * Number(policy.min_impulse_volume_ratio);
}

function next_structural_node(nodes, entry_usd, direction) {
  if (direction === 'bullish') return nodes.find((node) => node.strike_usd > entry_usd) || null;
  return [...nodes].reverse().find((node) => node.strike_usd < entry_usd) || null;
}

function nearest_local_gamma_node(nodes, entry_usd) {
  return nodes.filter((node) => Number.isFinite(node.net_gex_usd) && node.net_gex_usd !== 0).sort((left, right) => {
    const distance = Math.abs(left.strike_usd - entry_usd) - Math.abs(right.strike_usd - entry_usd);
    return distance || (Math.abs(right.net_gex_usd) - Math.abs(left.net_gex_usd));
  })[0] || null;
}

function dominant_magnet_node(nodes, excluded_strike = null) {
  const candidates = nodes.filter((node) => (
    node.net_gex_usd > 0
    && (excluded_strike === null || node.strike_usd !== excluded_strike)
  ));
  const named = candidates.filter(is_magnet_node);
  return strongest_by(named.length > 0 ? named : candidates, 'net_gex_usd');
}

function plan_target(candidate, nodes, local_gamma_node) {
  if (candidate.setup_type === 'node_rejection' && local_gamma_node.net_gex_usd > 0) {
    const magnet = dominant_magnet_node(nodes, candidate.tested_node.strike_usd);
    const in_direction = magnet && (
      (candidate.direction === 'bullish' && magnet.strike_usd > candidate.entry_usd)
      || (candidate.direction === 'bearish' && magnet.strike_usd < candidate.entry_usd)
    );
    if (in_direction) return { node: magnet, basis: 'positive_gamma_magnet_center' };
  }
  return {
    node: next_structural_node(nodes, candidate.entry_usd, candidate.direction),
    basis: candidate.setup_type === 'breakout_retest'
      ? 'accepted_boundary_next_structural_node'
      : 'rejection_next_structural_node',
  };
}

function breakout_candidate(node, bars, vwap_usd, policy) {
  const setup = bars.at(-3);
  const impulse = bars.at(-2);
  const retest = bars.at(-1);
  const tolerance = Number(policy.node_tolerance_points);
  const displacement = Number(policy.min_displacement_points);
  const min_body = Number(policy.min_body_points);
  const stop_buffer = Number(policy.stop_buffer_points);
  const impulse_body = Math.abs(impulse.close_usd - impulse.open_usd);

  const bullish = setup.close_usd < node.strike_usd
    && impulse.open_usd < node.strike_usd
    && impulse.close_usd >= node.strike_usd + displacement
    && impulse.close_usd > impulse.open_usd
    && impulse_body >= min_body
    && retest.low_usd <= node.strike_usd + tolerance
    && retest.low_usd >= node.strike_usd - stop_buffer
    && retest.close_usd > node.strike_usd
    && volume_confirms(impulse, setup, policy)
    && vwap_confirms('bullish', retest.close_usd, vwap_usd, policy);
  if (bullish) {
    return {
      direction: 'bullish',
      setup_type: 'breakout_retest',
      tested_node: node,
      entry_usd: retest.close_usd,
      setup_bar_at: setup.timestamp,
      impulse_bar_at: impulse.timestamp,
      confirmation_bar_at: retest.timestamp,
    };
  }

  const bearish = setup.close_usd > node.strike_usd
    && impulse.open_usd > node.strike_usd
    && impulse.close_usd <= node.strike_usd - displacement
    && impulse.close_usd < impulse.open_usd
    && impulse_body >= min_body
    && retest.high_usd >= node.strike_usd - tolerance
    && retest.high_usd <= node.strike_usd + stop_buffer
    && retest.close_usd < node.strike_usd
    && volume_confirms(impulse, setup, policy)
    && vwap_confirms('bearish', retest.close_usd, vwap_usd, policy);
  if (bearish) {
    return {
      direction: 'bearish',
      setup_type: 'breakout_retest',
      tested_node: node,
      entry_usd: retest.close_usd,
      setup_bar_at: setup.timestamp,
      impulse_bar_at: impulse.timestamp,
      confirmation_bar_at: retest.timestamp,
    };
  }
  return null;
}

function rejection_candidate(node, bars, vwap_usd, policy) {
  const test_bar = bars.at(-2);
  const confirm = bars.at(-1);
  const tolerance = Number(policy.node_tolerance_points);
  const min_body = Number(policy.min_body_points);
  const stop_buffer = Number(policy.stop_buffer_points);

  const bearish = test_bar.high_usd >= node.strike_usd - tolerance
    && test_bar.high_usd <= node.strike_usd + stop_buffer
    && test_bar.close_usd < node.strike_usd
    && confirm.high_usd <= node.strike_usd + stop_buffer
    && confirm.close_usd < test_bar.close_usd
    && confirm.close_usd < confirm.open_usd
    && Math.abs(confirm.close_usd - confirm.open_usd) >= min_body
    && volume_confirms(confirm, test_bar, policy)
    && vwap_confirms('bearish', confirm.close_usd, vwap_usd, policy);
  if (bearish) {
    return {
      direction: 'bearish',
      setup_type: 'node_rejection',
      tested_node: node,
      entry_usd: confirm.close_usd,
      setup_bar_at: test_bar.timestamp,
      impulse_bar_at: null,
      confirmation_bar_at: confirm.timestamp,
    };
  }

  const bullish = test_bar.low_usd <= node.strike_usd + tolerance
    && test_bar.low_usd >= node.strike_usd - stop_buffer
    && test_bar.close_usd > node.strike_usd
    && confirm.low_usd >= node.strike_usd - stop_buffer
    && confirm.close_usd > test_bar.close_usd
    && confirm.close_usd > confirm.open_usd
    && Math.abs(confirm.close_usd - confirm.open_usd) >= min_body
    && volume_confirms(confirm, test_bar, policy)
    && vwap_confirms('bullish', confirm.close_usd, vwap_usd, policy);
  if (bullish) {
    return {
      direction: 'bullish',
      setup_type: 'node_rejection',
      tested_node: node,
      entry_usd: confirm.close_usd,
      setup_bar_at: test_bar.timestamp,
      impulse_bar_at: null,
      confirmation_bar_at: confirm.timestamp,
    };
  }
  return null;
}

function candidate_plan(candidate, nodes, policy) {
  const local_gamma_node = nearest_local_gamma_node(nodes, candidate.entry_usd);
  if (!local_gamma_node) return null;
  // Negative gamma is a volatility-expansion regime, not a bearish label.
  // In that regime we only follow a completed boundary break and failed
  // retest; a simple rejection is too ambiguous for a directional long option.
  if (candidate.setup_type === 'node_rejection' && local_gamma_node.net_gex_usd < 0) return null;
  if (
    candidate.setup_type === 'node_rejection'
    && local_gamma_node.net_gex_usd > 0
    && !policy.allow_positive_gamma_single_leg_mean_reversion
  ) {
    return { blocked_reason: 'positive_gamma_pin_requires_defined_risk_structure' };
  }
  const target_plan = plan_target(candidate, nodes, local_gamma_node);
  const target = target_plan.node;
  if (!target || target.strike_usd === candidate.tested_node.strike_usd) return null;
  const signal_type = candidate.setup_type === 'breakout_retest'
    ? (local_gamma_node.net_gex_usd < 0 ? 'negative_gamma_expansion' : 'positive_wall_acceptance')
    : 'positive_gamma_mean_reversion';
  const stop_buffer = Number(policy.stop_buffer_points);
  const stop_underlying_usd = candidate.direction === 'bullish'
    ? candidate.tested_node.strike_usd - stop_buffer
    : candidate.tested_node.strike_usd + stop_buffer;
  const risk_points = Math.abs(candidate.entry_usd - stop_underlying_usd);
  const reward_points = Math.abs(target.strike_usd - candidate.entry_usd);
  const reward_risk_ratio = risk_points > 0 ? reward_points / risk_points : 0;
  if (reward_risk_ratio < Number(policy.min_reward_risk_ratio)) return null;
  return {
    ...candidate,
    signal_type,
    regime: local_gamma_node.net_gex_usd < 0
      ? 'negative_gamma_expansion'
      : (candidate.setup_type === 'node_rejection' ? 'positive_gamma_mean_reversion' : 'positive_gamma_boundary_acceptance'),
    local_gamma_node,
    target_node: target,
    target_basis: target_plan.basis,
    stop_underlying_usd,
    target_underlying_usd: target.strike_usd,
    risk_points,
    reward_points,
    reward_risk_ratio,
  };
}

function history_snapshots({ gex_node_history, gex_snapshot, max_nodes }) {
  const raw = [
    ...(Array.isArray(gex_node_history) ? gex_node_history : []),
    gex_snapshot,
  ];
  const by_timestamp = new Map();
  for (const item of raw) {
    const normalized = normalize_gex_snapshot(item, max_nodes);
    const at_ms = timestamp_ms(normalized.snapshot_at);
    if (at_ms === null || normalized.nodes.length === 0) continue;
    by_timestamp.set(at_ms, normalized);
  }
  return [...by_timestamp.values()]
    .sort((left, right) => timestamp_ms(left.snapshot_at) - timestamp_ms(right.snapshot_at));
}

function node_stability(plan, history, bars, snapshot, now_ms, policy) {
  const strike_tolerance = Number(policy.gex_node_history_strike_tolerance_points);
  const signal_start_ms = timestamp_ms(bars[0].timestamp);
  const expected_sign = Math.sign(plan.tested_node.net_gex_usd);
  const matches = [];
  for (const sample of history) {
    const sample_ms = timestamp_ms(sample.snapshot_at);
    if (
      sample.session_date_et !== snapshot.session_date_et
      || sample_ms < signal_start_ms
      || sample_ms > Number(now_ms) + 5_000
    ) continue;
    const node = sample.nodes.find((candidate) => (
      Math.abs(candidate.strike_usd - plan.tested_node.strike_usd) <= strike_tolerance
      && Math.sign(candidate.net_gex_usd) === expected_sign
    ));
    if (!node) continue;
    matches.push({
      snapshot_at: sample.snapshot_at,
      strike_usd: node.strike_usd,
      net_gex_usd: node.net_gex_usd,
    });
  }

  const covered_bars = new Set();
  for (const match of matches) {
    const match_ms = timestamp_ms(match.snapshot_at);
    for (const bar of bars) {
      const start_ms = timestamp_ms(bar.timestamp);
      if (match_ms >= start_ms && match_ms < start_ms + Number(policy.closed_bar_interval_ms)) {
        covered_bars.add(bar.timestamp);
      }
    }
  }
  return {
    matched_sample_count: matches.length,
    covered_bar_count: covered_bars.size,
    preferred_bar_coverage_met: covered_bars.size >= Number(policy.preferred_gex_node_history_bar_coverage),
    first_matched_at: matches[0]?.snapshot_at || null,
    last_matched_at: matches.at(-1)?.snapshot_at || null,
    matched_samples: matches,
  };
}

function candidate_score(plan, policy) {
  const preferred_coverage = Math.min(
    plan.gex_node_stability.covered_bar_count,
    Number(policy.preferred_gex_node_history_bar_coverage),
  );
  const coverage_bonus = preferred_coverage * 1_000_000_000_000_000;
  const gamma_bonus = plan.signal_type === 'negative_gamma_expansion'
    || plan.signal_type === 'positive_gamma_mean_reversion' ? 1_000_000_000_000 : 0;
  return coverage_bonus + gamma_bonus + Math.abs(plan.tested_node.net_gex_usd)
    + (plan.reward_risk_ratio * 1_000);
}

function current_price_reasons(plan, last_price_usd, policy) {
  const reasons = [];
  if (plan.direction === 'bullish') {
    if (last_price_usd <= plan.stop_underlying_usd) reasons.push('setup_invalidated_before_execution');
    if (last_price_usd >= plan.target_underlying_usd) reasons.push('target_reached_before_execution');
    if (last_price_usd <= plan.tested_node.strike_usd) reasons.push('current_price_lost_tested_node');
  } else {
    if (last_price_usd >= plan.stop_underlying_usd) reasons.push('setup_invalidated_before_execution');
    if (last_price_usd <= plan.target_underlying_usd) reasons.push('target_reached_before_execution');
    if (last_price_usd >= plan.tested_node.strike_usd) reasons.push('current_price_lost_tested_node');
  }
  if (Math.abs(last_price_usd - plan.entry_usd) > Number(policy.max_entry_drift_points)) {
    reasons.push('entry_drift_above_limit');
  }
  return reasons;
}

function directional_option_node(nodes, direction) {
  return strongest_by(nodes, direction === 'bullish' ? 'call_gex_usd' : 'put_gex_usd');
}

function stable_signal_identity(snapshot, selected) {
  const setup_identity = {
    session_date_et: snapshot.session_date_et,
    ticker: snapshot.ticker,
    setup_type: selected.setup_type,
    signal_type: selected.signal_type,
    regime: selected.regime,
    direction: selected.direction,
    tested_node_strike_usd: rounded(selected.tested_node.strike_usd),
    local_gamma_node_strike_usd: rounded(selected.local_gamma_node.strike_usd),
    target_node_strike_usd: rounded(selected.target_node.strike_usd),
    target_basis: selected.target_basis,
    setup_bar_at: selected.setup_bar_at,
    impulse_bar_at: selected.impulse_bar_at,
    confirmation_bar_at: selected.confirmation_bar_at,
  };
  const identity = Object.values(setup_identity).map((value) => String(value ?? '')).join('|');
  return {
    signal_id: `junk_gex_${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`,
    setup_id: `junk_gex_setup_${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`,
    setup_identity,
  };
}

export function evaluate_junk_gex_strategy({
  gex_snapshot,
  gex_node_history,
  market_context,
  policy,
  now_ms = Date.now(),
} = {}) {
  const resolved_policy = merged_policy(policy);
  const snapshot = normalize_gex_snapshot(gex_snapshot, resolved_policy.max_nodes);
  const base = base_result(snapshot, market_context, resolved_policy);
  const reason_codes = [];

  if (!snapshot.ticker) reason_codes.push('missing_ticker');
  if (!Number.isFinite(snapshot.spot_usd)) reason_codes.push('missing_spot');
  if (!resolved_policy.allowed_snapshot_states.includes(snapshot.state)) {
    reason_codes.push(`snapshot_state_not_allowed:${snapshot.state || 'missing'}`);
  }
  const snapshot_at_ms = timestamp_ms(snapshot.snapshot_at);
  if (snapshot_at_ms === null) {
    reason_codes.push('missing_or_invalid_snapshot_at');
  } else if ((Number(now_ms) - snapshot_at_ms) > Number(resolved_policy.max_snapshot_age_ms)) {
    reason_codes.push('snapshot_stale');
  } else if (snapshot_at_ms > Number(now_ms) + 5_000) {
    reason_codes.push('snapshot_from_future');
  }
  // The provider exposes both the source timestamp and an independently
  // calculated freshness value.  Treat either one exceeding the hard policy
  // limit as stale; a provider-level `state: fresh` must never override age.
  const meta_freshness_seconds = response_meta_freshness_seconds(gex_snapshot);
  if (meta_freshness_seconds !== null) {
    if (meta_freshness_seconds < -5) {
      reason_codes.push('snapshot_meta_from_future');
    } else if (meta_freshness_seconds * 1_000 > Number(resolved_policy.max_snapshot_age_ms)) {
      reason_codes.push('snapshot_meta_stale');
    }
  }
  if (snapshot.nodes.length < 2) reason_codes.push('insufficient_gex_nodes');

  const last_price_usd = finite_number(market_context?.last_price_usd);
  const vwap_usd = finite_number(market_context?.vwap_usd);
  if (!Number.isFinite(last_price_usd)) reason_codes.push('missing_last_price');
  if (resolved_policy.require_vwap_confirmation && !Number.isFinite(vwap_usd)) reason_codes.push('missing_vwap');
  const bar_validation = validate_signal_bars(
    market_context?.bars_5m ?? market_context?.bars_1m,
    snapshot,
    now_ms,
    resolved_policy,
  );
  reason_codes.push(...bar_validation.reason_codes);
  if (reason_codes.length > 0) return no_trade(base, reason_codes);

  const history = history_snapshots({
    gex_node_history: gex_node_history ?? market_context?.gex_node_history,
    gex_snapshot,
    max_nodes: resolved_policy.max_nodes,
  });
  const plans = [];
  let stability_blocked = false;
  let bar_coverage_blocked = false;
  let structure_blocked = false;
  for (const node of snapshot.nodes) {
    const breakout = breakout_candidate(node, bar_validation.bars, vwap_usd, resolved_policy);
    const rejection = rejection_candidate(node, bar_validation.bars, vwap_usd, resolved_policy);
    for (const candidate of [breakout, rejection].filter(Boolean)) {
      const plan = candidate_plan(candidate, snapshot.nodes, resolved_policy);
      if (!plan) continue;
      if (plan.blocked_reason) {
        structure_blocked = true;
        continue;
      }
      const gex_node_stability = node_stability(
        plan,
        history,
        bar_validation.bars,
        snapshot,
        now_ms,
        resolved_policy,
      );
      if (gex_node_stability.matched_sample_count < Number(resolved_policy.min_gex_node_history_samples)) {
        stability_blocked = true;
        continue;
      }
      if (resolved_policy.require_gex_node_history_bar_coverage && !gex_node_stability.preferred_bar_coverage_met) {
        bar_coverage_blocked = true;
        continue;
      }
      plans.push({ ...plan, gex_node_stability });
    }
  }
  if (plans.length === 0) {
    return no_trade(base, [
      bar_coverage_blocked
        ? 'gex_node_history_missing_confirmation_bar_coverage'
        : (stability_blocked
          ? 'insufficient_stable_gex_node_history'
          : (structure_blocked ? 'positive_gamma_pin_requires_defined_risk_structure' : 'waiting_for_node_confirmation')),
    ]);
  }

  plans.sort((left, right) => candidate_score(right, resolved_policy) - candidate_score(left, resolved_policy));
  const selected = plans[0];
  const current_reasons = current_price_reasons(selected, last_price_usd, resolved_policy);
  if (current_reasons.length > 0) return no_trade(base, current_reasons);
  const dominant_magnet = dominant_magnet_node(snapshot.nodes);
  if (
    dominant_magnet
    && !is_wall_node(selected.tested_node)
    && !is_gamma_flip_node(selected.tested_node)
    && Math.abs(last_price_usd - dominant_magnet.strike_usd) <= Number(resolved_policy.magnet_dead_zone_points)
  ) {
    return no_trade(base, ['positive_gamma_magnet_center_no_chase']);
  }

  const option_right = selected.direction === 'bullish' ? 'call' : 'put';
  const option_node = directional_option_node(snapshot.nodes, selected.direction);
  if (!option_node) return no_trade(base, [`missing_${option_right}_gex_option_node`]);
  const strike_step = Number(resolved_policy.option_strike_step_points);
  const strike_offset = Number(resolved_policy.option_strike_offset_points);
  const toward_spot = Math.sign(snapshot.spot_usd - option_node.strike_usd) * strike_offset;
  const shifted_strike = option_node.strike_usd + toward_spot;
  const option_strike_reference_usd = Math.round(shifted_strike / strike_step) * strike_step;
  const identity = stable_signal_identity(snapshot, selected);

  return {
    ...base,
    ...identity,
    decision: 'trade',
    action: 'open_long_option',
    reason_codes: [
      selected.signal_type,
      'gex_node_confirmed',
      'gex_node_history_stable',
      Number(resolved_policy.closed_bar_interval_ms) === FIVE_MINUTE_MS
        ? 'five_minute_acceptance_or_rejection_confirmed'
        : 'closed_bar_acceptance_or_rejection_confirmed',
      ...(resolved_policy.require_volume_confirmation ? ['volume_confirmed'] : []),
      ...(resolved_policy.require_vwap_confirmation ? ['vwap_confirmed'] : []),
    ],
    direction: selected.direction,
    setup_type: selected.setup_type,
    signal_type: selected.signal_type,
    regime: selected.regime,
    node_reaction: selected.setup_type,
    local_gamma_regime: selected.local_gamma_node.net_gex_usd < 0 ? 'negative' : 'positive',
    local_gamma_node: selected.local_gamma_node,
    tested_node: selected.tested_node,
    target_node: selected.target_node,
    target_basis: selected.target_basis,
    dominant_magnet_node: dominant_magnet,
    gex_node_stability: selected.gex_node_stability,
    entry_reference_usd: rounded(selected.entry_usd),
    stop_underlying_usd: rounded(selected.stop_underlying_usd),
    target_underlying_usd: rounded(selected.target_underlying_usd),
    risk_points: rounded(selected.risk_points),
    reward_points: rounded(selected.reward_points),
    reward_risk_ratio: rounded(selected.reward_risk_ratio),
    option_selection: {
      option_right,
      expiry_days: Number(resolved_policy.option_expiry_days),
      strike_reference_usd: rounded(option_strike_reference_usd),
      strike_basis: `max_${option_right}_gex_node_shifted_toward_spot`,
      source_node: option_node,
      strike_offset_points: rounded(strike_offset),
      quote_and_liquidity_gate_required: true,
    },
  };
}
