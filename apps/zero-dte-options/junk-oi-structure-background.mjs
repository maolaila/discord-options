const DAY_MS = 86_400_000;
const DEFAULT_HISTORY_WINDOWS = Object.freeze([3, 5, 10]);
const DEFAULT_MAX_HISTORY_DAYS = 60;
const DEFAULT_MAX_SOURCE_AGE_MS = 36 * 60 * 60 * 1_000;

function finite_number(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonnegative_number(value) {
  const parsed = finite_number(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function first_number(source, keys, { nonnegative = false } = {}) {
  for (const key of keys) {
    if (!source || !Object.hasOwn(source, key)) continue;
    return nonnegative ? nonnegative_number(source[key]) : finite_number(source[key]);
  }
  return null;
}

function first_string(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== null && value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return null;
}

function iso_timestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function date_key(value) {
  const text = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null;
}

function rounded(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function response_payload(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  return response.data && typeof response.data === 'object' ? response.data : response;
}

function response_rows(response, keys) {
  const payload = response_payload(response);
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function response_as_of(response) {
  const payload = response_payload(response);
  return iso_timestamp(
    response?._meta?.as_of
      ?? response?.as_of
      ?? payload?.as_of
      ?? payload?.source_as_of
      ?? payload?.generated_at,
  );
}

function freshness_reason(response, source_as_of, captured_at_ms, max_source_age_ms, prefix) {
  const payload = response_payload(response);
  const state = String(
    response?._meta?.state
      ?? response?._meta?.freshness
      ?? payload?.state
      ?? payload?.freshness
      ?? 'fresh',
  ).trim().toLowerCase();
  if (!source_as_of) return `${prefix}_source_as_of_missing`;
  const as_of_ms = Date.parse(source_as_of);
  if (as_of_ms > captured_at_ms + 5_000) return `${prefix}_source_as_of_from_future`;
  if (captured_at_ms - as_of_ms > max_source_age_ms) return `${prefix}_source_stale`;
  if (!['fresh', 'current', 'ok'].includes(state)) return `${prefix}_freshness_not_usable:${state || 'missing'}`;
  return null;
}

export function parse_spx_osi_contract(value) {
  const contract = String(value || '').trim().toUpperCase();
  const match = contract.match(/^(SPXW|SPX)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!match) return null;
  const expiration = date_key(`20${match[2]}-${match[3]}-${match[4]}`);
  if (!expiration) return null;
  return Object.freeze({
    contract,
    root: match[1],
    ticker: 'SPX',
    expiration,
    right: match[5] === 'C' ? 'call' : 'put',
    strike_usd: Number(match[6]) / 1_000,
  });
}

function normalize_contract(record, expected_activity_trade_date, expected_oi_effective_date) {
  const reason_codes = [];
  const symbol = first_string(record, ['contract', 'option_symbol', 'optionSymbol', 'symbol']);
  const osi = parse_spx_osi_contract(symbol);
  if (!osi) return { record: null, reason_codes: ['invalid_or_non_spx_osi_contract'] };
  const explicit_ticker = first_string(record, ['ticker', 'underlying', 'underlying_symbol']);
  if (explicit_ticker && explicit_ticker.toUpperCase() !== 'SPX') reason_codes.push('contract_ticker_mismatch');

  const activity_trade_date = date_key(first_string(record, ['prev_date', 'activity_trade_date']));
  const oi_effective_date = date_key(first_string(record, ['date', 'oi_effective_date']));
  if (!activity_trade_date) reason_codes.push('contract_prev_date_missing_or_invalid');
  if (!oi_effective_date) reason_codes.push('contract_date_missing_or_invalid');
  if (activity_trade_date && activity_trade_date !== expected_activity_trade_date) {
    reason_codes.push('activity_trade_date_mismatch');
  }
  if (oi_effective_date && oi_effective_date !== expected_oi_effective_date) {
    reason_codes.push('oi_effective_date_mismatch');
  }
  const explicit_expiration = date_key(first_string(record, ['expiration', 'expiry', 'expiration_date']));
  if (explicit_expiration && explicit_expiration !== osi.expiration) reason_codes.push('osi_expiration_mismatch');
  const explicit_right = first_string(record, ['right', 'option_type', 'type'])?.toLowerCase();
  if (explicit_right) {
    const normalized_right = explicit_right === 'c' ? 'call' : explicit_right === 'p' ? 'put' : explicit_right;
    if (normalized_right !== osi.right) reason_codes.push('osi_right_mismatch');
  }
  const explicit_strike = first_number(record, ['strike_usd', 'strike']);
  if (explicit_strike !== null && Math.abs(explicit_strike - osi.strike_usd) > 0.0001) {
    reason_codes.push('osi_strike_mismatch');
  }

  const oi = first_number(record, ['oi', 'open_interest'], { nonnegative: true });
  const prev_oi = first_number(record, ['prev_oi', 'previous_open_interest'], { nonnegative: true });
  const explicit_oi_diff = first_number(record, ['oi_diff', 'open_interest_diff']);
  const oi_diff = explicit_oi_diff ?? (oi !== null && prev_oi !== null ? oi - prev_oi : null);
  const volume = first_number(record, ['volume', 'option_volume'], { nonnegative: true });
  const trades = first_number(record, ['trades', 'trade_count'], { nonnegative: true });
  const avg_price_usd = first_number(record, ['avg_price_usd', 'avg_price', 'average_price'], { nonnegative: true });
  const premium_keys = ['premium_usd', 'premium', 'total_premium'];
  const official_premium_key = premium_keys.find((key) => Object.hasOwn(record, key));
  const official_premium_raw = official_premium_key ? record[official_premium_key] : null;
  const official_premium_explicitly_missing = official_premium_key === undefined
    || official_premium_raw === null
    || official_premium_raw === undefined
    || String(official_premium_raw).trim() === '';
  const official_premium = official_premium_explicitly_missing
    ? null
    : nonnegative_number(official_premium_raw);
  if (!official_premium_explicitly_missing && official_premium === null) {
    reason_codes.push('official_premium_invalid');
  }
  const estimated_premium = official_premium_explicitly_missing && volume !== null && avg_price_usd !== null
    ? volume * avg_price_usd * 100
    : null;
  const premium_usd = official_premium ?? estimated_premium;

  return {
    record: {
      ...osi,
      activity_trade_date,
      oi_effective_date,
      oi,
      prev_oi,
      oi_diff,
      oi_change: first_number(record, ['oi_change', 'open_interest_change_pct']),
      volume,
      trades,
      avg_price_usd,
      premium_usd: rounded(premium_usd, 2),
      premium_source: official_premium !== null ? 'official' : estimated_premium !== null ? 'estimated' : 'unknown',
      premium_is_estimated: estimated_premium !== null,
      data_complete: reason_codes.length === 0,
      reason_codes,
    },
    reason_codes,
  };
}

function sum_known(rows, field) {
  const values = rows.map((row) => finite_number(row?.[field])).filter((value) => value !== null);
  return values.length > 0 ? rounded(values.reduce((sum, value) => sum + value, 0), 6) : null;
}

function aggregate_strikes(contracts) {
  const groups = new Map();
  for (const contract of contracts) {
    const key = `${contract.strike_usd}|${contract.right}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(contract);
  }
  return [...groups.values()].map((rows) => ({
    ticker: 'SPX',
    strike_usd: rows[0].strike_usd,
    right: rows[0].right,
    expirations: [...new Set(rows.map((row) => row.expiration))].sort(),
    contract_count: rows.length,
    oi: sum_known(rows, 'oi'),
    prev_oi: sum_known(rows, 'prev_oi'),
    oi_diff: sum_known(rows, 'oi_diff'),
    volume: sum_known(rows, 'volume'),
    trades: sum_known(rows, 'trades'),
    premium_usd: sum_known(rows, 'premium_usd'),
    incomplete_fields: ['oi', 'prev_oi', 'oi_diff', 'volume', 'trades', 'premium_usd']
      .filter((field) => rows.some((row) => row[field] === null)),
    contracts: rows.map((row) => row.contract).sort(),
  })).sort((left, right) => left.strike_usd - right.strike_usd || left.right.localeCompare(right.right));
}

function normalize_options_volume(response) {
  if (!response) return null;
  const payload = response_payload(response);
  const rows = response_rows(response, ['rows', 'tickers', 'results']);
  const payload_ticker = first_string(payload, ['ticker', 'symbol']);
  if (payload_ticker && payload_ticker.toUpperCase() !== 'SPX') return null;
  const explicit = rows.find((row) => String(row?.ticker || row?.symbol || '').toUpperCase() === 'SPX')
    ?? (String(payload?.ticker || payload?.symbol || '').toUpperCase() === 'SPX' ? payload : null);
  // Real options.options_volume is a market-wide SPX-oriented singleton and
  // currently returns { as_of, day: {...} } without a ticker field.
  const day = payload?.day && typeof payload.day === 'object' && !Array.isArray(payload.day)
    ? payload.day
    : null;
  const source = explicit ?? day;
  if (!source) return null;
  const metric = (keys, options) => first_number(source, keys, options);
  return {
    ticker: 'SPX',
    date: date_key(first_string(source, ['date', 'session_date'])),
    session_partial_or_semantically_independent: true,
    can_trigger_trade: false,
    can_veto_candidate: false,
    intraday_directional_signal: false,
    excluded_from_score: true,
    call_volume: metric(['call_volume', 'calls_volume'], { nonnegative: true }),
    put_volume: metric(['put_volume', 'puts_volume'], { nonnegative: true }),
    call_volume_ask_side: metric(['call_volume_ask_side', 'call_ask_side_volume'], { nonnegative: true }),
    call_volume_bid_side: metric(['call_volume_bid_side', 'call_bid_side_volume'], { nonnegative: true }),
    put_volume_ask_side: metric(['put_volume_ask_side', 'put_ask_side_volume'], { nonnegative: true }),
    put_volume_bid_side: metric(['put_volume_bid_side', 'put_bid_side_volume'], { nonnegative: true }),
    call_premium_usd: metric(['call_premium_usd', 'call_premium'], { nonnegative: true }),
    put_premium_usd: metric(['put_premium_usd', 'put_premium'], { nonnegative: true }),
    signed_net_premium_usd: metric(['signed_net_premium_usd', 'net_premium_usd']),
    net_call_premium_usd: metric(['net_call_premium_usd', 'net_call_premium', 'net_call']),
    net_put_premium_usd: metric(['net_put_premium_usd', 'net_put_premium', 'net_put']),
    bullish_premium_usd: metric(['bullish_premium_usd', 'bullish_premium', 'bullish'], { nonnegative: true }),
    bearish_premium_usd: metric(['bearish_premium_usd', 'bearish_premium', 'bearish'], { nonnegative: true }),
    call_open_interest: metric(['call_open_interest', 'call_oi'], { nonnegative: true }),
    put_open_interest: metric(['put_open_interest', 'put_oi'], { nonnegative: true }),
    average_call_volume_3d: metric(['avg_3_day_call_volume', 'average_call_volume_3d', 'avg_call_volume_3d', 'call_volume_3d_avg'], { nonnegative: true }),
    average_put_volume_3d: metric(['avg_3_day_put_volume', 'average_put_volume_3d', 'avg_put_volume_3d', 'put_volume_3d_avg'], { nonnegative: true }),
    average_call_volume_7d: metric(['avg_7_day_call_volume', 'average_call_volume_7d', 'avg_call_volume_7d', 'call_volume_7d_avg'], { nonnegative: true }),
    average_put_volume_7d: metric(['avg_7_day_put_volume', 'average_put_volume_7d', 'avg_put_volume_7d', 'put_volume_7d_avg'], { nonnegative: true }),
    average_call_volume_30d: metric(['avg_30_day_call_volume', 'average_call_volume_30d', 'avg_call_volume_30d', 'call_volume_30d_avg'], { nonnegative: true }),
    average_put_volume_30d: metric(['avg_30_day_put_volume', 'average_put_volume_30d', 'avg_put_volume_30d', 'put_volume_30d_avg'], { nonnegative: true }),
    average_volume_3d: metric(['average_volume_3d', 'avg_volume_3d'], { nonnegative: true }),
    average_volume_7d: metric(['average_volume_7d', 'avg_volume_7d'], { nonnegative: true }),
    average_volume_30d: metric(['average_volume_30d', 'avg_volume_30d'], { nonnegative: true }),
  };
}

function identity_for_record(record, level) {
  return level === 'contract' ? record.contract : `${record.strike_usd}|${record.right}`;
}

function streaks(ordered) {
  let oi_up_streak = 0;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const value = finite_number(ordered[index]?.oi_diff);
    if (value === null || value <= 0) break;
    oi_up_streak += 1;
  }
  function growth(field) {
    let count = 0;
    for (let index = ordered.length - 1; index > 0; index -= 1) {
      const current = finite_number(ordered[index]?.[field]);
      const previous = finite_number(ordered[index - 1]?.[field]);
      if (current === null || previous === null || current < previous * 1.05) break;
      count += 1;
    }
    return count;
  }
  const premium_up_streak = growth('premium_usd');
  const volume_up_streak = growth('volume');
  return {
    oi_up_streak,
    premium_up_streak,
    volume_up_streak,
    triple_up_streak: Math.min(oi_up_streak, premium_up_streak, volume_up_streak),
  };
}

function add_history_features(current_rows, snapshots, level, windows) {
  const rows_by_snapshot = snapshots.map((snapshot) => (
    level === 'contract' ? snapshot.contracts || [] : snapshot.strikes || aggregate_strikes(snapshot.contracts || [])
  ));
  return current_rows.map((current) => {
    const identity = identity_for_record(current, level);
    const series = [];
    for (let index = 0; index < snapshots.length; index += 1) {
      const match = rows_by_snapshot[index].find((row) => identity_for_record(row, level) === identity);
      series.push(match ? { ...match, activity_trade_date: snapshots[index].activity_trade_date } : null);
    }
    const observations = series.filter(Boolean);
    const window_summaries = {};
    const insufficient_history = [];
    for (const window of windows) {
      const selected = series.slice(-window);
      const sufficient = selected.length === window && selected.every(Boolean);
      const complete_sum = (field) => (
        sufficient && selected.every((row) => finite_number(row?.[field]) !== null)
          ? sum_known(selected, field)
          : null
      );
      if (!sufficient) insufficient_history.push(window);
      window_summaries[String(window)] = {
        sufficient_history: sufficient,
        observation_count: selected.filter(Boolean).length,
        oi_diff_cumulative: complete_sum('oi_diff'),
        volume_cumulative: complete_sum('volume'),
        premium_usd_cumulative: complete_sum('premium_usd'),
        incomplete_metrics: sufficient
          ? ['oi_diff', 'volume', 'premium_usd']
            .filter((field) => selected.some((row) => finite_number(row?.[field]) === null))
          : ['history'],
      };
    }
    return {
      ...current,
      history: {
        observation_count: observations.length,
        ...streaks(series),
        windows: window_summaries,
        insufficient_history,
      },
    };
  });
}

function activity_score(contracts, strikes) {
  function absolute_sum_known(field) {
    const values = contracts.map((row) => finite_number(row[field])).filter((value) => value !== null);
    return values.length > 0 ? values.reduce((sum, value) => sum + Math.abs(value), 0) : null;
  }
  const oi_activity = absolute_sum_known('oi_diff');
  const premium = absolute_sum_known('premium_usd');
  const volume = absolute_sum_known('volume');
  const known_strike_diffs = strikes.map((row) => finite_number(row.oi_diff)).filter((value) => value !== null);
  const breadth = known_strike_diffs.length > 0
    ? known_strike_diffs.filter((value) => value !== 0).length
    : null;
  const factors = [
    { name: 'oi_diff_absolute_activity', weight: 35, value: oi_activity, scale: 10_000 },
    { name: 'premium_activity', weight: 30, value: premium, scale: 10_000_000 },
    { name: 'volume_activity', weight: 20, value: volume, scale: 100_000 },
    { name: 'strike_right_breadth', weight: 15, value: breadth, scale: 10, linear: true },
  ].map((factor) => ({
    ...factor,
    normalized: factor.value === null
      ? null
      : Math.min(1, factor.linear ? factor.value / factor.scale : Math.log1p(factor.value) / Math.log1p(factor.scale)),
  }));
  const available = factors.filter((factor) => factor.normalized !== null);
  const available_weight = available.reduce((sum, factor) => sum + factor.weight, 0);
  const value = available_weight > 0
    ? available.reduce((sum, factor) => sum + factor.normalized * factor.weight, 0) * (100 / available_weight)
    : null;
  return {
    value: rounded(value, 2),
    available_weight,
    unavailable_factors: factors.filter((factor) => factor.normalized === null).map((factor) => factor.name),
    factors: factors.map(({ name, weight, value: raw_value, normalized }) => ({
      name,
      weight,
      raw_value: raw_value === null ? null : rounded(raw_value, 6),
      normalized: rounded(normalized, 6),
    })),
  };
}

export function junk_oi_history_snapshot_identity(snapshot) {
  const activity = date_key(snapshot?.activity_trade_date);
  const effective = date_key(snapshot?.oi_effective_date);
  const ticker = String(snapshot?.ticker || '').trim().toUpperCase();
  return activity && effective && ticker === 'SPX' ? `${activity}|${effective}|SPX` : null;
}

export function merge_junk_oi_history_snapshots(history, snapshot, { max_days = DEFAULT_MAX_HISTORY_DAYS } = {}) {
  const limit = Math.floor(Number(max_days));
  if (!Number.isFinite(limit) || limit < 1 || limit > DEFAULT_MAX_HISTORY_DAYS) {
    throw new RangeError(`max_days must be between 1 and ${DEFAULT_MAX_HISTORY_DAYS}`);
  }
  const incoming_identity = junk_oi_history_snapshot_identity(snapshot);
  if (!incoming_identity) throw new TypeError('snapshot requires valid SPX dual-date identity');
  const by_identity = new Map();
  for (const item of Array.isArray(history) ? history : []) {
    const identity = junk_oi_history_snapshot_identity(item);
    if (identity) by_identity.set(identity, item);
  }
  by_identity.set(incoming_identity, snapshot);
  return [...by_identity.values()]
    .sort((left, right) => junk_oi_history_snapshot_identity(left).localeCompare(junk_oi_history_snapshot_identity(right)))
    .slice(-limit);
}

export function build_junk_oi_structure_background({
  oi_change_response,
  options_volume_response = null,
  expected_activity_trade_date,
  expected_oi_effective_date,
  history_snapshots = [],
  captured_at = new Date(),
  max_source_age_ms = DEFAULT_MAX_SOURCE_AGE_MS,
  rolling_windows = DEFAULT_HISTORY_WINDOWS,
} = {}) {
  const activity_trade_date = date_key(expected_activity_trade_date);
  const oi_effective_date = date_key(expected_oi_effective_date);
  const captured_at_iso = iso_timestamp(captured_at);
  if (!captured_at_iso) throw new TypeError('captured_at must be a valid timestamp');
  const captured_at_ms = Date.parse(captured_at_iso);
  const max_age = Number(max_source_age_ms);
  if (!Number.isFinite(max_age) || max_age < 0) throw new TypeError('max_source_age_ms must be non-negative');
  const windows = [...new Set(rolling_windows.map(Number))].filter((value) => Number.isInteger(value) && value > 1).sort((a, b) => a - b);

  const reason_codes = [];
  const optional_context_reason_codes = [];
  if (!activity_trade_date) reason_codes.push('expected_activity_trade_date_missing_or_invalid');
  if (!oi_effective_date) reason_codes.push('expected_oi_effective_date_missing_or_invalid');
  if (activity_trade_date && oi_effective_date) {
    const activity_ms = Date.parse(`${activity_trade_date}T00:00:00.000Z`);
    const effective_ms = Date.parse(`${oi_effective_date}T00:00:00.000Z`);
    if (effective_ms <= activity_ms || effective_ms - activity_ms > 4 * DAY_MS) {
      reason_codes.push('dual_date_sequence_invalid');
    }
  }

  const oi_source_as_of = response_as_of(oi_change_response);
  reason_codes.push(...[freshness_reason(
    oi_change_response,
    oi_source_as_of,
    captured_at_ms,
    max_age,
    'oi_change',
  )].filter(Boolean));
  if (options_volume_response) {
    optional_context_reason_codes.push(...[freshness_reason(
      options_volume_response,
      response_as_of(options_volume_response),
      captured_at_ms,
      max_age,
      'options_volume',
    )].filter(Boolean));
  }

  const oi_payload = response_payload(oi_change_response);
  const response_ticker = first_string(oi_payload, ['ticker', 'symbol', 'underlying']);
  if (response_ticker && response_ticker.toUpperCase() !== 'SPX') reason_codes.push('oi_change_ticker_mismatch');
  const response_activity_date = date_key(first_string(oi_payload, ['prev_date', 'activity_trade_date']));
  const response_effective_date = date_key(first_string(oi_payload, ['date', 'oi_effective_date']));
  if (response_activity_date && response_activity_date !== activity_trade_date) {
    reason_codes.push('oi_change_activity_trade_date_mismatch');
  }
  if (response_effective_date && response_effective_date !== oi_effective_date) {
    reason_codes.push('oi_change_oi_effective_date_mismatch');
  }
  if (oi_source_as_of && oi_effective_date && oi_source_as_of.slice(0, 10) !== oi_effective_date) {
    reason_codes.push('oi_change_source_as_of_date_mismatch');
  }

  const raw_contracts = response_rows(oi_change_response, ['contracts', 'rows', 'results']);
  if (raw_contracts.length === 0) reason_codes.push('oi_change_contracts_missing');
  const contracts = [];
  for (const raw of raw_contracts) {
    const normalized = normalize_contract(raw, activity_trade_date, oi_effective_date);
    reason_codes.push(...normalized.reason_codes);
    if (normalized.record) contracts.push(normalized.record);
  }
  if (contracts.length === 0) reason_codes.push('no_valid_spx_contracts');
  const duplicate_contracts = contracts.length - new Set(contracts.map((row) => row.contract)).size;
  if (duplicate_contracts > 0) reason_codes.push('duplicate_contract_identity');
  const options_volume = optional_context_reason_codes.length === 0
    ? normalize_options_volume(options_volume_response)
    : null;
  if (options_volume_response && !options_volume && optional_context_reason_codes.length === 0) {
    optional_context_reason_codes.push('options_volume_spx_record_missing');
  }

  const base_snapshot = {
    ticker: 'SPX',
    activity_trade_date,
    oi_effective_date,
    source_as_of: oi_source_as_of,
    captured_at: captured_at_iso,
    contracts,
    strikes: aggregate_strikes(contracts),
  };
  const merged_history = junk_oi_history_snapshot_identity(base_snapshot)
    ? merge_junk_oi_history_snapshots(
      history_snapshots,
      base_snapshot,
      { max_days: DEFAULT_MAX_HISTORY_DAYS },
    )
    : (Array.isArray(history_snapshots) ? history_snapshots : [])
      .filter((snapshot) => junk_oi_history_snapshot_identity(snapshot))
      .slice(-DEFAULT_MAX_HISTORY_DAYS);
  const contracts_with_history = add_history_features(contracts, merged_history, 'contract', windows);
  const strikes_with_history = add_history_features(base_snapshot.strikes, merged_history, 'strike', windows);
  const unique_reasons = [...new Set(reason_codes)];
  const usable = unique_reasons.length === 0;
  const score = usable ? activity_score(contracts, base_snapshot.strikes) : null;

  return {
    kind: 'junk_oi_structure_background',
    version: 1,
    ticker: 'SPX',
    context_only: true,
    can_trigger_trade: false,
    can_veto_candidate: false,
    intraday_directional_signal: false,
    settlement_lagged: true,
    usable,
    state: usable ? 'usable_context' : 'invalid_fail_closed',
    activity_trade_date,
    oi_effective_date,
    source_as_of: oi_source_as_of,
    captured_at: captured_at_iso,
    options_volume_source_as_of: options_volume_response ? response_as_of(options_volume_response) : null,
    options_volume,
    contracts: contracts_with_history,
    strikes: strikes_with_history,
    score: {
      value: score?.value ?? null,
      available_weight: score?.available_weight ?? 0,
      unavailable_factors: score?.unavailable_factors ?? [],
      factors: score?.factors ?? [],
      meaning: 'settlement_confirmed_structure_activity_intensity_only',
      directional_interpretation_allowed: false,
    },
    reason_codes: usable
      ? ['settlement_lagged_oi_structure_context_ready', 'not_intraday_trade_evidence']
      : unique_reasons,
    optional_context_reason_codes: [...new Set(optional_context_reason_codes)],
    evidence: {
      contract_count: contracts.length,
      call_contract_count: contracts.filter((row) => row.right === 'call').length,
      put_contract_count: contracts.filter((row) => row.right === 'put').length,
      strike_right_group_count: base_snapshot.strikes.length,
      official_premium_contract_count: contracts.filter((row) => row.premium_source === 'official').length,
      estimated_premium_contract_count: contracts.filter((row) => row.premium_is_estimated).length,
      unknown_premium_contract_count: contracts.filter((row) => row.premium_usd === null).length,
      rolling_windows: windows,
      history_snapshot_count: merged_history.length,
      coverage_limit: 'options.oi_change may be a highlighted subset, not a complete option chain',
    },
    history_snapshot: usable ? base_snapshot : null,
  };
}

export const normalize_junk_oi_structure_background = build_junk_oi_structure_background;

export function junk_oi_structure_background_digest(background) {
  const source = background && typeof background === 'object' && !Array.isArray(background)
    ? background
    : {};
  const ticker = String(source.ticker || 'SPX').trim().toUpperCase();
  const context_id = [
    ticker,
    source.activity_trade_date || 'unknown_activity_date',
    source.oi_effective_date || 'unknown_effective_date',
    source.source_as_of || 'unknown_source_as_of',
  ].join('|');
  return {
    kind: 'junk_oi_structure_background_ref',
    version: source.version || 1,
    context_id,
    ticker,
    usable: source.usable === true,
    state: source.state || 'unavailable',
    activity_trade_date: source.activity_trade_date || null,
    oi_effective_date: source.oi_effective_date || null,
    source_as_of: source.source_as_of || null,
    captured_at: source.captured_at || null,
    score: source.score || null,
    reason_codes: Array.isArray(source.reason_codes) ? source.reason_codes : [],
    optional_context_reason_codes: Array.isArray(source.optional_context_reason_codes)
      ? source.optional_context_reason_codes
      : [],
    context_only: true,
    can_trigger_trade: false,
    can_veto_candidate: false,
    intraday_directional_signal: false,
    settlement_lagged: true,
    detail_storage: 'daily_artifact_and_local_sqlite',
  };
}

export function attach_junk_oi_structure_background(decision, background) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new TypeError('decision must be an object');
  }
  const safe_background = junk_oi_structure_background_digest(background);
  return {
    ...decision,
    oi_structure_background: safe_background,
    evidence_model: {
      ...(decision.evidence_model && typeof decision.evidence_model === 'object'
        ? decision.evidence_model
        : {}),
      oi_structure_background: {
        kind: safe_background.kind,
        context_id: safe_background.context_id,
        state: safe_background.state,
        usable: safe_background.usable,
        context_only: true,
        can_trigger_trade: false,
        can_veto_candidate: false,
      },
    },
  };
}
