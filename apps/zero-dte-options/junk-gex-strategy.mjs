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
  closed_bar_interval_ms: FIVE_MINUTE_MS,
  closed_bar_interval_tolerance_ms: 1_000,
  require_volume_confirmation: true,
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

function canonical_option_right(value) {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'CALL') return 'C';
  if (token === 'PUT') return 'P';
  return token === 'C' || token === 'P' ? token : null;
}

export function parse_osi_contract_symbol(value) {
  const match = String(value || '').trim().toUpperCase()
    .match(/^([A-Z0-9.]{1,8})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!match) return null;
  const expiration = `20${match[2]}-${match[3]}-${match[4]}`;
  const parsed_date = new Date(`${expiration}T00:00:00.000Z`);
  if (
    parsed_date.getUTCFullYear() !== 2000 + Number(match[2])
    || parsed_date.getUTCMonth() + 1 !== Number(match[3])
    || parsed_date.getUTCDate() !== Number(match[4])
  ) return null;
  return {
    contract_symbol: match[0],
    contract_root: match[1],
    expiration,
    right: match[5],
    strike_usd: Number(match[6]) / 1_000,
  };
}

function canonical_contract_root(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Rank same-expiry Call or Put strikes from fields observed in Nightwatch's
 * official option-chain response. Dealer GEX nodes expose only net_gex_usd;
 * they do not expose a per-node Call/Put split. Within one underlying/expiry,
 * gamma * open interest has the same rank as conventional GEX magnitude because
 * spot and contract multiplier are common factors.
 */
export function directional_option_gex_reference({
  option_chain_snapshot,
  direction,
  expiration,
  ticker,
  now_ms = null,
  max_age_ms = null,
} = {}) {
  const option_right = direction === 'bullish' ? 'C' : (direction === 'bearish' ? 'P' : null);
  const source = option_chain_snapshot?.data && typeof option_chain_snapshot.data === 'object'
    ? option_chain_snapshot.data
    : option_chain_snapshot;
  const source_ticker = String(source?.ticker || '').trim().toUpperCase();
  const expected_ticker = String(ticker || source_ticker).trim().toUpperCase();
  const source_expiration = String(source?.expiration || '').slice(0, 10);
  const expected_expiration = String(expiration || '').slice(0, 10);
  const contracts = Array.isArray(source?.contracts) ? source.contracts : [];
  if (!option_right || !/^\d{4}-\d{2}-\d{2}$/.test(expected_expiration)) return null;
  if (!expected_ticker || source_ticker !== expected_ticker || source_expiration !== expected_expiration) return null;
  // Live responses from the official endpoint expose this truncation marker
  // and the timestamps below. Treat missing provenance as incomplete rather
  // than pretending the public OpenAPI schema documents more than it does.
  if (option_chain_snapshot?._meta?.truncated !== false) return null;
  const freshness_seconds = finite_number(option_chain_snapshot?._meta?.data_freshness_seconds);
  const source_snapshot_ms = timestamp_ms(source?.snapshot_at);
  const greeks_as_of_ms = timestamp_ms(source?.greeks_as_of);
  const open_interest_as_of_ms = timestamp_ms(source?.open_interest_as_of);
  if (source_snapshot_ms === null || greeks_as_of_ms === null || open_interest_as_of_ms === null) return null;
  if (open_interest_as_of_ms > source_snapshot_ms + 5_000) return null;
  if (
    now_ms !== null
    && max_age_ms !== null
    && Number.isFinite(Number(now_ms))
    && Number.isFinite(Number(max_age_ms))
  ) {
    if (source_snapshot_ms === null || greeks_as_of_ms === null) return null;
    const age_ms = Number(now_ms) - source_snapshot_ms;
    const greeks_age_ms = Number(now_ms) - greeks_as_of_ms;
    if (age_ms < -5_000 || age_ms > Number(max_age_ms)) return null;
    if (greeks_age_ms < -5_000 || greeks_age_ms > Number(max_age_ms)) return null;
    if (freshness_seconds !== null && freshness_seconds * 1_000 > Number(max_age_ms)) return null;
  }

  const by_strike = new Map();
  for (const contract of contracts) {
    const contract_symbol = String(contract?.contract_symbol || '').trim().toUpperCase();
    const symbol_identity = parse_osi_contract_symbol(contract_symbol);
    const contract_expiration = String(contract?.expiration || '').slice(0, 10);
    const strike_usd = finite_number(contract?.strike_usd);
    const contract_right = canonical_option_right(contract?.right);
    const gamma = finite_number(contract?.gamma);
    const open_interest = finite_number(contract?.open_interest);
    if (
      !symbol_identity
      || (expected_ticker === 'SPX'
        ? symbol_identity.contract_root !== 'SPXW'
        : canonical_contract_root(symbol_identity.contract_root) !== canonical_contract_root(expected_ticker))
      || symbol_identity.expiration !== expected_expiration
      || symbol_identity.right !== option_right
      || Math.abs(symbol_identity.strike_usd - strike_usd) > 0.0001
      || contract_expiration !== expected_expiration
      || contract_right !== option_right
      || !Number.isFinite(strike_usd)
      || !Number.isFinite(gamma)
      || !Number.isFinite(open_interest)
      || gamma <= 0
      || open_interest <= 0
    ) continue;
    const gamma_oi_weight = gamma * open_interest;
    if (!(gamma_oi_weight > 0)) continue;
    const previous = by_strike.get(strike_usd) || {
      strike_usd,
      gamma_oi_weight: 0,
      contract_count: 0,
      open_interest: 0,
      contract_root: symbol_identity.contract_root,
    };
    previous.gamma_oi_weight += gamma_oi_weight;
    previous.contract_count += 1;
    previous.open_interest += open_interest;
    by_strike.set(strike_usd, previous);
  }

  const selected = [...by_strike.values()].sort((left, right) => (
    right.gamma_oi_weight - left.gamma_oi_weight
    || left.strike_usd - right.strike_usd
  ))[0] || null;
  if (!selected) return null;
  return {
    strike_usd: selected.strike_usd,
    option_right: option_right === 'C' ? 'call' : 'put',
    contract_root: selected.contract_root,
    expiration: expected_expiration,
    gamma_oi_weight: rounded(selected.gamma_oi_weight, 8),
    open_interest: rounded(selected.open_interest),
    contract_count: selected.contract_count,
    source: 'nightwatch_options_chain_snapshot_gross_gamma_oi_proxy',
    source_field: 'data.contracts[].gamma*open_interest',
    source_snapshot_at: iso_timestamp(source?.snapshot_at),
    greeks_as_of: iso_timestamp(source?.greeks_as_of),
    data_freshness_seconds: rounded(freshness_seconds),
    open_interest_as_of: iso_timestamp(source?.open_interest_as_of),
    open_interest_is_settlement_lagged: true,
  };
}

function normalize_strike(strike) {
  const normalized = {
    strike_usd: finite_number(strike?.strike_usd),
    net_gex_usd: finite_number(strike?.net_gex_usd),
    node_type: strike?.node_type ? String(strike.node_type) : null,
    rank: finite_number(strike?.rank),
    relative_strength: finite_number(strike?.relative_strength),
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

function is_magnet_node(node) {
  const type = structural_node_type(node);
  return type.includes('magnet') || type.split(/[^a-z]+/).includes('mag');
}

function strongest_by(nodes, field) {
  return nodes
    .filter((node) => Number.isFinite(node[field]))
    .sort((left, right) => Math.abs(right[field]) - Math.abs(left[field]))[0] || null;
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

export function normalize_gex_snapshot(gex_snapshot) {
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
    }
    // junk_man explicitly says he generally does not trade from Flip. Preserve
    // the summary value as audit context, but never synthesize a tradable node
    // when the provider did not rank that strike in `strikes`.
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
  // The provider response is already a bounded ranked snapshot. Do not add an
  // undocumented application-side node cap that could discard a valid tested
  // node or its next structural target.
  const nodes = all_nodes.sort((left, right) => left.strike_usd - right.strike_usd);

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
    'closed_bar_interval_tolerance_ms',
  ];
  const positive = [
    'closed_bar_interval_ms',
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
  if (!Array.isArray(raw_bars) || raw_bars.length < 1) {
    return { bars: [], reason_codes: ['insufficient_closed_confirmation_bars'] };
  }
  const latest = normalize_bar(raw_bars.at(-1));
  const reason_codes = [];
  if (!latest) return { bars: [], reason_codes: ['invalid_closed_confirmation_bar'] };
  if (policy.require_volume_confirmation && !Number.isFinite(latest.volume)) {
    reason_codes.push('missing_closed_bar_volume');
  }

  const interval = Number(policy.closed_bar_interval_ms);
  const tolerance = Number(policy.closed_bar_interval_tolerance_ms);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(snapshot.session_date_et || ''))) {
    reason_codes.push('missing_or_invalid_session_date_et');
  } else if (date_in_new_york(latest.timestamp) !== snapshot.session_date_et) {
    reason_codes.push('closed_confirmation_bars_cross_et_session');
  }

  const latest_start_ms = timestamp_ms(latest.timestamp);
  const latest_end_ms = latest_start_ms + interval;
  if (latest_end_ms > Number(now_ms) + tolerance) {
    reason_codes.push('latest_confirmation_bar_not_closed');
  }

  // A completed rejection candle is independently actionable in junk_man's
  // description. Only expose a second bar to the breakout/retest evaluator when
  // that prior bar is valid, contiguous, closed, and in the same ET session;
  // malformed prior context must not become a hidden two-bar rejection gate.
  const bars = [latest];
  let next_start_ms = latest_start_ms;
  for (let index = raw_bars.length - 2; index >= 0; index -= 1) {
    const previous = normalize_bar(raw_bars[index]);
    if (!previous) break;
    const previous_start_ms = timestamp_ms(previous.timestamp);
    const previous_same_session = /^\d{4}-\d{2}-\d{2}$/.test(String(snapshot.session_date_et || ''))
      && date_in_new_york(previous.timestamp) === snapshot.session_date_et;
    if (
      Math.abs(next_start_ms - previous_start_ms - interval) > tolerance
      || previous_start_ms + interval > Number(now_ms) + tolerance
      || !previous_same_session
    ) break;
    bars.unshift(previous);
    next_start_ms = previous_start_ms;
  }
  return { bars, reason_codes };
}

function volume_confirms(bars, policy) {
  if (!policy.require_volume_confirmation) return true;
  return bars.every((bar) => Number.isFinite(bar?.volume) && bar.volume > 0);
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

function plan_target(candidate, nodes) {
  return {
    node: next_structural_node(nodes, candidate.entry_usd, candidate.direction),
    basis: candidate.setup_type === 'breakout_retest'
      ? 'accepted_boundary_next_structural_node'
      : 'rejection_next_structural_node',
  };
}

function breakout_candidate(node, bars, policy) {
  if (bars.length < 2) return null;
  const retest = bars.at(-1);

  // junk_man requires a pullback to the key level with a wick after the body
  // break. The provider does not publish a node-region width, so require the
  // wick to reach the node itself instead of inventing a point tolerance.

  const bullish_retest = retest.low_usd <= node.strike_usd
    && retest.low_usd < Math.min(retest.open_usd, retest.close_usd)
    && retest.close_usd > node.strike_usd
    && volume_confirms([retest], policy);
  const bullish_impulse_index = bullish_retest
    ? bars.slice(0, -1).findLastIndex((bar, index, preceding) => (
      bar.open_usd < node.strike_usd
      && bar.close_usd > node.strike_usd
      && bar.close_usd > bar.open_usd
      && volume_confirms([bar], policy)
      && preceding.slice(index + 1).every((held) => held.close_usd > node.strike_usd)
    ))
    : -1;
  if (bullish_impulse_index >= 0) {
    const impulse = bars[bullish_impulse_index];
    return {
      direction: 'bullish',
      setup_type: 'breakout_retest',
      tested_node: node,
      entry_usd: retest.close_usd,
      invalidation_usd: retest.low_usd,
      setup_bar_at: impulse.timestamp,
      impulse_bar_at: impulse.timestamp,
      confirmation_bar_at: retest.timestamp,
      confirmation_bars: [impulse, retest],
    };
  }

  const bearish_retest = retest.high_usd >= node.strike_usd
    && retest.high_usd > Math.max(retest.open_usd, retest.close_usd)
    && retest.close_usd < node.strike_usd
    && volume_confirms([retest], policy);
  const bearish_impulse_index = bearish_retest
    ? bars.slice(0, -1).findLastIndex((bar, index, preceding) => (
      bar.open_usd > node.strike_usd
      && bar.close_usd < node.strike_usd
      && bar.close_usd < bar.open_usd
      && volume_confirms([bar], policy)
      && preceding.slice(index + 1).every((held) => held.close_usd < node.strike_usd)
    ))
    : -1;
  if (bearish_impulse_index >= 0) {
    const impulse = bars[bearish_impulse_index];
    return {
      direction: 'bearish',
      setup_type: 'breakout_retest',
      tested_node: node,
      entry_usd: retest.close_usd,
      invalidation_usd: retest.high_usd,
      setup_bar_at: impulse.timestamp,
      impulse_bar_at: impulse.timestamp,
      confirmation_bar_at: retest.timestamp,
      confirmation_bars: [impulse, retest],
    };
  }
  return null;
}

function rejection_candidate(node, bars, policy) {
  const confirm = bars.at(-1);
  if (!confirm) return null;

  // junk_man explicitly says one completed five-minute candle that stabilizes
  // is enough. A rejection candle must touch the node, close back on the
  // original side, be the reverse colour, and carry a rejection wick. No
  // second confirmation candle or fixed wick/body ratio is added.
  const bearish = confirm.high_usd >= node.strike_usd
    && confirm.open_usd < node.strike_usd
    && confirm.close_usd < node.strike_usd
    && confirm.close_usd < confirm.open_usd
    && confirm.high_usd > Math.max(confirm.open_usd, confirm.close_usd)
    && volume_confirms([confirm], policy);
  if (bearish) {
    return {
      direction: 'bearish',
      setup_type: 'node_rejection',
      tested_node: node,
      entry_usd: confirm.close_usd,
      invalidation_usd: confirm.high_usd,
      setup_bar_at: confirm.timestamp,
      impulse_bar_at: null,
      confirmation_bar_at: confirm.timestamp,
      confirmation_bars: [confirm],
    };
  }

  const bullish = confirm.low_usd <= node.strike_usd
    && confirm.open_usd > node.strike_usd
    && confirm.close_usd > node.strike_usd
    && confirm.close_usd > confirm.open_usd
    && confirm.low_usd < Math.min(confirm.open_usd, confirm.close_usd)
    && volume_confirms([confirm], policy);
  if (bullish) {
    return {
      direction: 'bullish',
      setup_type: 'node_rejection',
      tested_node: node,
      entry_usd: confirm.close_usd,
      invalidation_usd: confirm.low_usd,
      setup_bar_at: confirm.timestamp,
      impulse_bar_at: null,
      confirmation_bar_at: confirm.timestamp,
      confirmation_bars: [confirm],
    };
  }
  return null;
}

function candidate_plan(candidate, nodes) {
  const local_gamma_node = nearest_local_gamma_node(nodes, candidate.entry_usd);
  // A ranked node's sign is useful context, but it is not a direct long/short
  // label and does not define the whole local Gamma region. junk_man explicitly
  // trades price rejection at both positive- and negative-Gamma structure, so
  // the sign must not veto an otherwise confirmed price reaction.
  const target_plan = plan_target(candidate, nodes);
  const target = target_plan.node;
  if (!target || target.strike_usd === candidate.tested_node.strike_usd) return null;
  const signal_type = candidate.setup_type === 'breakout_retest'
    ? 'gex_node_breakout_retest'
    : 'gex_node_rejection';
  const stop_underlying_usd = candidate.invalidation_usd;
  const risk_points = Math.abs(candidate.entry_usd - stop_underlying_usd);
  const reward_points = Math.abs(target.strike_usd - candidate.entry_usd);
  const reward_risk_ratio = risk_points > 0 ? reward_points / risk_points : 0;
  return {
    ...candidate,
    signal_type,
    regime: candidate.setup_type,
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

function history_snapshots({ gex_node_history, gex_snapshot }) {
  const raw = [
    ...(Array.isArray(gex_node_history) ? gex_node_history : []),
    gex_snapshot,
  ];
  const by_timestamp = new Map();
  for (const item of raw) {
    const normalized = normalize_gex_snapshot(item);
    const at_ms = timestamp_ms(normalized.snapshot_at);
    if (at_ms === null || normalized.nodes.length === 0) continue;
    by_timestamp.set(at_ms, normalized);
  }
  return [...by_timestamp.values()]
    .sort((left, right) => timestamp_ms(left.snapshot_at) - timestamp_ms(right.snapshot_at));
}

function node_stability(plan, history, bars, snapshot, now_ms, policy) {
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
      Math.abs(candidate.strike_usd - plan.tested_node.strike_usd) <= 0.0001
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
    observed_across_multiple_samples: matches.length >= 2,
    first_matched_at: matches[0]?.snapshot_at || null,
    last_matched_at: matches.at(-1)?.snapshot_at || null,
    matched_samples: matches,
  };
}

function compare_candidates(left, right) {
  const left_rank = finite_number(left.tested_node.rank) ?? Number.POSITIVE_INFINITY;
  const right_rank = finite_number(right.tested_node.rank) ?? Number.POSITIVE_INFINITY;
  return left_rank - right_rank
    || Math.abs(right.tested_node.net_gex_usd) - Math.abs(left.tested_node.net_gex_usd)
    || left.tested_node.strike_usd - right.tested_node.strike_usd;
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
  return reasons;
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
    local_gamma_node_strike_usd: rounded(selected.local_gamma_node?.strike_usd),
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
  option_chain_snapshot,
  market_context,
  policy,
  now_ms = Date.now(),
} = {}) {
  const resolved_policy = merged_policy(policy);
  const snapshot = normalize_gex_snapshot(gex_snapshot);
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
  if (!Number.isFinite(last_price_usd)) reason_codes.push('missing_last_price');
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
  });
  const plans = [];
  const candidate_block_reasons = new Set();
  for (const node of snapshot.nodes) {
    const breakout = breakout_candidate(node, bar_validation.bars, resolved_policy);
    const rejection = rejection_candidate(node, bar_validation.bars, resolved_policy);
    for (const candidate of [breakout, rejection].filter(Boolean)) {
      const plan = candidate_plan(candidate, snapshot.nodes);
      if (!plan) continue;
      if (plan.blocked_reason) {
        candidate_block_reasons.add(plan.blocked_reason);
        continue;
      }
      const gex_node_stability = node_stability(
        plan,
        history,
        plan.confirmation_bars,
        snapshot,
        now_ms,
        resolved_policy,
      );
      plans.push({ ...plan, gex_node_stability });
    }
  }
  if (plans.length === 0) {
    if (candidate_block_reasons.size > 0) return no_trade(base, [...candidate_block_reasons]);
    return no_trade(base, ['waiting_for_node_confirmation']);
  }

  plans.sort(compare_candidates);
  const selected = plans[0];
  const current_reasons = current_price_reasons(selected, last_price_usd, resolved_policy);
  if (current_reasons.length > 0) return no_trade(base, current_reasons);
  const dominant_magnet = dominant_magnet_node(snapshot.nodes);

  const option_right = selected.direction === 'bullish' ? 'call' : 'put';
  const option_reference = directional_option_gex_reference({
    option_chain_snapshot,
    direction: selected.direction,
    expiration: snapshot.session_date_et,
    ticker: snapshot.ticker,
    now_ms,
    max_age_ms: resolved_policy.max_snapshot_age_ms,
  });
  if (!option_reference) return no_trade(base, [`missing_${option_right}_directional_gex_reference`]);
  const strike_step = Number(resolved_policy.option_strike_step_points);
  const strike_offset = Number(resolved_policy.option_strike_offset_points);
  const toward_current_price = Math.sign(last_price_usd - option_reference.strike_usd) * strike_offset;
  const shifted_strike = option_reference.strike_usd + toward_current_price;
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
      Number(resolved_policy.closed_bar_interval_ms) === FIVE_MINUTE_MS
        ? 'five_minute_acceptance_or_rejection_confirmed'
        : 'closed_bar_acceptance_or_rejection_confirmed',
      ...(resolved_policy.require_volume_confirmation ? ['volume_data_present'] : []),
    ],
    direction: selected.direction,
    setup_type: selected.setup_type,
    signal_type: selected.signal_type,
    regime: selected.regime,
    node_reaction: selected.setup_type,
    nearest_ranked_node_gamma_sign: selected.local_gamma_node?.net_gex_usd < 0
      ? 'negative'
      : (selected.local_gamma_node?.net_gex_usd > 0 ? 'positive' : 'zero_or_unknown'),
    local_gamma_node: selected.local_gamma_node,
    tested_node: selected.tested_node,
    target_node: selected.target_node,
    target_basis: selected.target_basis,
    dominant_magnet_node: dominant_magnet,
    gex_node_stability: selected.gex_node_stability,
    invalidation_basis: 'underlying_confirmation_bar_wick_proxy',
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
      strike_basis: `max_${option_right}_gamma_oi_shifted_toward_current_price`,
      source_node: option_reference,
      strike_offset_points: rounded(strike_offset),
      quote_and_liquidity_gate_required: true,
    },
  };
}
