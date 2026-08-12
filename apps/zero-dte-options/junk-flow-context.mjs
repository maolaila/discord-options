import fs from 'node:fs';

const NEW_YORK_TIME_ZONE = 'America/New_York';
const DEFAULT_WINDOW_SECONDS = Object.freeze([60, 180]);

export const DEFAULT_JUNK_FLOW_CONTEXT_POLICY = Object.freeze({
  max_tail_bytes: 512 * 1024,
  max_tail_rows: 4_000,
  future_tolerance_ms: 5_000,
  evaluation_window_seconds: 180,
  min_confirming_event_count: 2,
  min_confirming_premium_usd: 200_000,
  min_confirming_supportive_to_opposite_ratio: 2,
  min_large_sweep_premium_usd: 100_000,
  min_same_strike_event_count: 2,
  min_opposite_event_count: 2,
  min_opposite_premium_usd: 200_000,
  min_opposite_to_supportive_ratio: 2,
});

function finite_number(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive_number(value) {
  const parsed = finite_number(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function nonnegative_integer(value) {
  const parsed = finite_number(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function bounded_integer(value, fallback, { minimum = 1 } = {}) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function rounded(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function timestamp_ms(value) {
  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function iso_timestamp(value) {
  const parsed = timestamp_ms(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function resolve_now_ms(now_ms) {
  const resolved = typeof now_ms === 'function' ? now_ms() : now_ms;
  const parsed = timestamp_ms(resolved);
  if (parsed === null) throw new TypeError('now_ms must resolve to a valid timestamp');
  return parsed;
}

function normalized_string(value) {
  return String(value ?? '').trim();
}

function normalized_token(value) {
  return normalized_string(value).toLowerCase().replace(/[\s-]+/g, '_');
}

function date_key_in_new_york(value) {
  const parsed = timestamp_ms(value);
  if (parsed === null) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: NEW_YORK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(parsed));
  const by_type = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${by_type.year}-${by_type.month}-${by_type.day}`;
}

function normalized_ticker(value) {
  const ticker = normalized_string(value).toUpperCase().replace(/^\$/, '');
  return ticker === 'SPX' || ticker === 'SPY' ? ticker : null;
}

function normalized_option_right(value) {
  const token = normalized_token(value);
  if (token === 'c' || token === 'call' || token === 'calls') return 'call';
  if (token === 'p' || token === 'put' || token === 'puts') return 'put';
  return null;
}

function normalized_dte(value) {
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d+)\s*dte$/i);
    if (match) return nonnegative_integer(match[1]);
  }
  return nonnegative_integer(value);
}

function normalized_aggressor(value) {
  const token = normalized_token(value);
  if (
    token === 'ask'
    || token === 'ask_buy'
    || token === 'buy_at_ask'
    || token === 'bought_at_ask'
  ) return 'ask_buy';
  return token || null;
}

function is_rest_history(event) {
  const tokens = [
    event?.observed_via,
    event?.source_type,
    event?.ingestion_mode,
    event?.delivery_mode,
  ].map(normalized_token).filter(Boolean);
  return tokens.some((token) => token.includes('rest') || token.includes('histor'));
}

function event_timestamp(event) {
  return iso_timestamp(
    event?.event_at
      ?? event?.alert_at
      ?? event?.message_created_at
      ?? event?.message_timestamp
      ?? event?.source_timestamp
      ?? event?.timestamp,
  );
}

function event_identity(event) {
  const event_id = normalized_string(event?.event_id ?? event?.sub_event_id);
  const message_id = normalized_string(event?.message_id);
  const payload_index = nonnegative_integer(
    event?.payload_index
      ?? event?.message_payload_index
      ?? event?.match_index
      ?? event?.line_index
      ?? event?.item_index,
  );
  return {
    event_id: event_id || null,
    message_payload_id: message_id
      ? `${message_id}:${payload_index ?? 0}`
      : null,
    payload_fingerprint: normalized_string(event?.payload_fingerprint) || null,
  };
}

function normalize_flow_event(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const identity = event_identity(event);
  const ticker = normalized_ticker(event.ticker ?? event.underlying);
  const option_right = normalized_option_right(
    event.option_right
      ?? event.right
      ?? event.option_type,
  );
  const premium_usd = positive_number(
    event.premium_usd
      ?? event.total_premium_usd
      ?? event.premium,
  );
  const trade_count = positive_number(
    event.contract_count
      ?? event.trade_count
      ?? event.quantity
      ?? event.contracts,
  );
  const execution_type = normalized_token(
    event.execution_type
      ?? event.flow_type
      ?? event.trade_type,
  );
  const strike_usd = positive_number(event.strike_usd ?? event.strike);
  const avg_option_price = positive_number(
    event.avg_option_price
      ?? event.average_option_price
      ?? event.avg_price,
  );
  return {
    ...identity,
    event_at: event_timestamp(event),
    observed_at: iso_timestamp(event.observed_at ?? event.received_at ?? event.captured_at),
    live_eligible: event.live_eligible === true,
    rest_history: is_rest_history(event),
    ticker,
    dte: normalized_dte(event.dte ?? event.days_to_expiration),
    option_right,
    aggressor: normalized_aggressor(
      event.aggressor
        ?? event.aggressor_side
        ?? event.trade_side
        ?? event.side,
    ),
    premium_usd,
    strike_usd,
    avg_option_price,
    contract_count: trade_count,
    trade_count,
    execution_type,
    is_sweep: event.is_sweep === true || execution_type.includes('sweep'),
    parse_valid: event.parse_valid === true,
    premium_consistent: event.premium_consistent === true,
    source_message_id: normalized_string(event.message_id) || null,
    source_event_id: identity.event_id,
  };
}

function empty_ticker_aggregate() {
  return {
    event_count: 0,
    sweep_count: 0,
    call_event_count: 0,
    put_event_count: 0,
    call_sweep_count: 0,
    put_sweep_count: 0,
    call_premium_usd: 0,
    put_premium_usd: 0,
    total_premium_usd: 0,
    net_call_premium_usd: 0,
    imbalance: 0,
    directional_bias: 'flat',
    source_message_ids: [],
    source_event_ids: [],
    event_records: [],
  };
}

function finalize_ticker_aggregate(aggregate) {
  aggregate.total_premium_usd = rounded(
    aggregate.call_premium_usd + aggregate.put_premium_usd,
    2,
  );
  aggregate.net_call_premium_usd = rounded(
    aggregate.call_premium_usd - aggregate.put_premium_usd,
    2,
  );
  aggregate.imbalance = aggregate.total_premium_usd > 0
    ? rounded(aggregate.net_call_premium_usd / aggregate.total_premium_usd, 6)
    : 0;
  aggregate.directional_bias = aggregate.net_call_premium_usd > 0
    ? 'call'
    : aggregate.net_call_premium_usd < 0
      ? 'put'
      : 'flat';
  return aggregate;
}

function aggregate_window(events, now_ms, window_seconds) {
  const cutoff_ms = now_ms - (window_seconds * 1_000);
  const tickers = {
    spx: empty_ticker_aggregate(),
    spy: empty_ticker_aggregate(),
  };
  const source_message_ids = new Set();
  const source_event_ids = new Set();
  let event_count = 0;
  for (const event of events) {
    const at_ms = timestamp_ms(event.event_at);
    if (at_ms === null || at_ms < cutoff_ms || at_ms > now_ms) continue;
    const aggregate = tickers[event.ticker.toLowerCase()];
    if (!aggregate) continue;
    event_count += 1;
    aggregate.event_count += 1;
    aggregate.sweep_count += event.is_sweep ? 1 : 0;
    aggregate.event_records.push({
      event_at: event.event_at,
      ticker: event.ticker,
      option_right: event.option_right,
      dte: event.dte,
      aggressor: event.aggressor,
      premium_usd: event.premium_usd,
      strike_usd: event.strike_usd,
      contract_count: event.contract_count,
      avg_option_price: event.avg_option_price,
      execution_type: event.execution_type,
      is_sweep: event.is_sweep,
      live_eligible: event.live_eligible,
      parse_valid: event.parse_valid,
      premium_consistent: event.premium_consistent,
      source_message_id: event.source_message_id,
      source_event_id: event.source_event_id,
    });
    if (event.source_message_id) {
      source_message_ids.add(event.source_message_id);
      aggregate.source_message_ids.push(event.source_message_id);
    }
    if (event.source_event_id) {
      source_event_ids.add(event.source_event_id);
      aggregate.source_event_ids.push(event.source_event_id);
    }
    if (event.option_right === 'call') {
      aggregate.call_event_count += 1;
      aggregate.call_sweep_count += event.is_sweep ? 1 : 0;
      aggregate.call_premium_usd += event.premium_usd;
    } else {
      aggregate.put_event_count += 1;
      aggregate.put_sweep_count += event.is_sweep ? 1 : 0;
      aggregate.put_premium_usd += event.premium_usd;
    }
  }
  return {
    window_seconds,
    event_count,
    source_message_ids: [...source_message_ids],
    source_event_ids: [...source_event_ids],
    tickers: {
      spx: finalize_ticker_aggregate({
        ...tickers.spx,
        source_message_ids: [...new Set(tickers.spx.source_message_ids)],
        source_event_ids: [...new Set(tickers.spx.source_event_ids)],
      }),
      spy: finalize_ticker_aggregate({
        ...tickers.spy,
        source_message_ids: [...new Set(tickers.spy.source_message_ids)],
        source_event_ids: [...new Set(tickers.spy.source_event_ids)],
      }),
    },
  };
}

function increment_reason(reason_counts, reason) {
  reason_counts[reason] = (reason_counts[reason] || 0) + 1;
}

function isolation_reasons(event, now_ms, session_date_et, future_tolerance_ms) {
  if (!event) return ['invalid_event'];
  const reasons = [];
  const at_ms = timestamp_ms(event.event_at);
  if (event.rest_history) reasons.push('rest_history');
  if (!event.live_eligible) reasons.push('not_live_eligible');
  if (event.dte !== 0) {
    reasons.push(event.dte === null ? 'missing_dte' : 'nonzero_dte');
  }
  if (event.aggressor !== 'ask_buy') reasons.push('not_ask_buy');
  if (!event.ticker) reasons.push('unsupported_ticker');
  if (!event.option_right) reasons.push('unsupported_option_right');
  if (event.premium_usd === null) reasons.push('missing_premium_usd');
  if (at_ms === null) {
    reasons.push('missing_event_at');
  } else {
    if (date_key_in_new_york(at_ms) !== session_date_et) reasons.push('not_current_et_session');
    if (at_ms > now_ms + future_tolerance_ms) reasons.push('event_from_future');
  }
  return reasons;
}

function normalized_policy(overrides = {}) {
  const min_large_sweep_premium_usd = positive_number(overrides.min_large_sweep_premium_usd)
    ?? DEFAULT_JUNK_FLOW_CONTEXT_POLICY.min_large_sweep_premium_usd;
  return {
    ...DEFAULT_JUNK_FLOW_CONTEXT_POLICY,
    ...overrides,
    max_tail_bytes: bounded_integer(
      overrides.max_tail_bytes,
      DEFAULT_JUNK_FLOW_CONTEXT_POLICY.max_tail_bytes,
    ),
    max_tail_rows: bounded_integer(
      overrides.max_tail_rows,
      DEFAULT_JUNK_FLOW_CONTEXT_POLICY.max_tail_rows,
    ),
    min_large_sweep_premium_usd,
    min_confirming_event_count: bounded_integer(
      overrides.min_confirming_event_count,
      DEFAULT_JUNK_FLOW_CONTEXT_POLICY.min_confirming_event_count,
      { minimum: 2 },
    ),
    min_opposite_event_count: bounded_integer(
      overrides.min_opposite_event_count,
      DEFAULT_JUNK_FLOW_CONTEXT_POLICY.min_opposite_event_count,
      { minimum: 2 },
    ),
    min_same_strike_event_count: bounded_integer(
      overrides.min_same_strike_event_count,
      DEFAULT_JUNK_FLOW_CONTEXT_POLICY.min_same_strike_event_count,
      { minimum: 2 },
    ),
  };
}

/**
 * Read only the bounded end of an NDJSON file. If reading starts inside a
 * record, the first partial line is deliberately discarded.
 */
export function read_bounded_ndjson_tail({
  file_path,
  fs_module = fs,
  max_tail_bytes = DEFAULT_JUNK_FLOW_CONTEXT_POLICY.max_tail_bytes,
  max_tail_rows = DEFAULT_JUNK_FLOW_CONTEXT_POLICY.max_tail_rows,
} = {}) {
  const resolved_max_bytes = bounded_integer(
    max_tail_bytes,
    DEFAULT_JUNK_FLOW_CONTEXT_POLICY.max_tail_bytes,
  );
  const resolved_max_rows = bounded_integer(
    max_tail_rows,
    DEFAULT_JUNK_FLOW_CONTEXT_POLICY.max_tail_rows,
  );
  const diagnostics = {
    file_exists: false,
    file_size_bytes: 0,
    bytes_read: 0,
    start_offset_bytes: 0,
    parsed_row_count: 0,
    malformed_row_count: 0,
    truncated_head: false,
    read_error: null,
  };
  if (!normalized_string(file_path)) {
    diagnostics.read_error = 'missing_file_path';
    return { events: [], diagnostics };
  }
  try {
    if (!fs_module.existsSync(file_path)) return { events: [], diagnostics };
    diagnostics.file_exists = true;
    const stat = fs_module.statSync(file_path);
    diagnostics.file_size_bytes = Number(stat.size) || 0;
    if (diagnostics.file_size_bytes <= 0) return { events: [], diagnostics };

    const bytes_to_read = Math.min(diagnostics.file_size_bytes, resolved_max_bytes);
    const start_offset = diagnostics.file_size_bytes - bytes_to_read;
    const descriptor = fs_module.openSync(file_path, 'r');
    let bytes_read = 0;
    const buffer = Buffer.alloc(bytes_to_read);
    try {
      bytes_read = fs_module.readSync(
        descriptor,
        buffer,
        0,
        bytes_to_read,
        start_offset,
      );
    } finally {
      fs_module.closeSync(descriptor);
    }
    diagnostics.bytes_read = bytes_read;
    diagnostics.start_offset_bytes = start_offset;
    diagnostics.truncated_head = start_offset > 0;

    let lines = buffer.subarray(0, bytes_read).toString('utf8').split(/\r?\n/);
    if (start_offset > 0) lines = lines.slice(1);
    lines = lines.map((line) => line.trim()).filter(Boolean).slice(-resolved_max_rows);
    const events = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        diagnostics.malformed_row_count += 1;
      }
    }
    diagnostics.parsed_row_count = events.length;
    return { events, diagnostics };
  } catch (error) {
    diagnostics.read_error = normalized_string(error?.code || error?.message || error) || 'read_failed';
    return { events: [], diagnostics };
  }
}

/**
 * Pure event normalization, isolation, deduplication and rolling aggregation.
 * It never creates a directional candidate or a trade signal.
 */
export function build_junk_flow_context({
  events = [],
  now_ms = Date.now(),
  source_present = true,
  source_connected = true,
  tail_diagnostics = null,
  policy = {},
} = {}) {
  const at_ms = resolve_now_ms(now_ms);
  const resolved_policy = normalized_policy(policy);
  const session_date_et = date_key_in_new_york(at_ms);
  const seen_event_ids = new Set();
  const seen_message_payload_ids = new Set();
  const seen_payload_fingerprints = new Set();
  const accepted_events = [];
  const isolation_reason_counts = {};
  let deduplicated_event_count = 0;
  let isolated_event_count = 0;

  for (const raw_event of Array.isArray(events) ? events : []) {
    const normalized = normalize_flow_event(raw_event);
    const identity = normalized || event_identity(raw_event);
    const duplicate = Boolean(
      (identity.event_id && seen_event_ids.has(identity.event_id))
      || (identity.message_payload_id && seen_message_payload_ids.has(identity.message_payload_id))
      || (identity.payload_fingerprint && seen_payload_fingerprints.has(identity.payload_fingerprint))
    );
    if (duplicate) {
      deduplicated_event_count += 1;
      continue;
    }
    if (identity.event_id) seen_event_ids.add(identity.event_id);
    if (identity.message_payload_id) seen_message_payload_ids.add(identity.message_payload_id);
    if (identity.payload_fingerprint) seen_payload_fingerprints.add(identity.payload_fingerprint);

    const reasons = isolation_reasons(
      normalized,
      at_ms,
      session_date_et,
      resolved_policy.future_tolerance_ms,
    );
    if (reasons.length > 0) {
      isolated_event_count += 1;
      for (const reason of reasons) increment_reason(isolation_reason_counts, reason);
      continue;
    }
    accepted_events.push(normalized);
  }

  if (tail_diagnostics?.malformed_row_count > 0) {
    isolation_reason_counts.malformed_ndjson = tail_diagnostics.malformed_row_count;
  }

  const windows = {};
  for (const window_seconds of DEFAULT_WINDOW_SECONDS) {
    windows[`window_${window_seconds}s`] = aggregate_window(accepted_events, at_ms, window_seconds);
  }

  const read_failed = Boolean(tail_diagnostics?.read_error);
  let availability_status = 'neutral';
  if (!source_present) availability_status = 'missing';
  else if (!source_connected || read_failed) availability_status = 'disconnected';
  else if (windows.window_180s.event_count > 0) availability_status = 'active';

  return {
    schema_version: 1,
    collected_at: new Date(at_ms).toISOString(),
    session_date_et,
    availability_status,
    source_present: Boolean(source_present),
    source_connected: Boolean(source_connected) && !read_failed,
    input_event_count: Array.isArray(events) ? events.length : 0,
    accepted_event_count: accepted_events.length,
    isolated_event_count,
    deduplicated_event_count,
    source_message_ids: [...new Set(accepted_events.map((event) => event.source_message_id).filter(Boolean))],
    source_event_ids: [...new Set(accepted_events.map((event) => event.source_event_id).filter(Boolean))],
    isolation_reason_counts,
    windows,
    tail_diagnostics: tail_diagnostics || null,
  };
}

function ratio_for_threshold(numerator, denominator) {
  if (numerator <= 0) return 0;
  if (denominator <= 0) return Number.POSITIVE_INFINITY;
  return numerator / denominator;
}

function ratio_for_output(numerator, denominator) {
  const ratio = ratio_for_threshold(numerator, denominator);
  return Number.isFinite(ratio) ? rounded(ratio, 6) : null;
}

function normalized_candidate_direction(value) {
  const token = normalized_token(value);
  if (token === 'bull' || token === 'bullish' || token === 'long') return 'bull';
  if (token === 'bear' || token === 'bearish' || token === 'short') return 'bear';
  return null;
}

function resolved_candidate_spot({
  candidate_spot_usd,
  candidate_last_price_usd,
  candidate,
} = {}) {
  return positive_number(
    candidate_last_price_usd
      ?? candidate_spot_usd
      ?? candidate?.last_price_usd
      ?? candidate?.spot_usd,
  );
}

function option_moneyness(option_right, strike_usd, spot_usd) {
  if (!option_right || !Number.isFinite(strike_usd) || !Number.isFinite(spot_usd)) return 'unknown';
  if (strike_usd === spot_usd) return 'atm';
  if (option_right === 'call') return strike_usd > spot_usd ? 'otm' : 'itm';
  return strike_usd < spot_usd ? 'otm' : 'itm';
}

function quality_assessment(record, candidate_spot_usd, thresholds) {
  const reason_codes = [];
  if (!record?.source_message_id) reason_codes.push('missing_source_message_id');
  if (!record?.source_event_id) reason_codes.push('missing_source_event_id');
  if (record?.live_eligible !== true) reason_codes.push('not_live_eligible');
  if (record?.parse_valid !== true) reason_codes.push('missing_or_invalid_parse_validation');
  if (record?.premium_consistent !== true) reason_codes.push('missing_or_invalid_premium_consistency');
  if (record?.dte !== 0) reason_codes.push('not_zero_dte');
  if (record?.aggressor !== 'ask_buy') reason_codes.push('not_ask_buy');
  if (!Number.isFinite(record?.strike_usd)) reason_codes.push('missing_strike_usd');
  if (!Number.isFinite(record?.contract_count)) reason_codes.push('missing_contract_count');
  if (!Number.isFinite(record?.avg_option_price)) reason_codes.push('missing_avg_option_price');
  if (!record?.execution_type) reason_codes.push('missing_execution_type');
  if (record?.execution_type !== 'sweep' || record?.is_sweep !== true) reason_codes.push('not_sweep');
  if (
    !Number.isFinite(record?.premium_usd)
    || record.premium_usd < thresholds.min_large_sweep_premium_usd
  ) {
    reason_codes.push('premium_below_large_sweep_threshold');
  }
  if (!Number.isFinite(candidate_spot_usd)) reason_codes.push('missing_candidate_spot_usd');
  const moneyness = option_moneyness(
    record?.option_right,
    record?.strike_usd,
    candidate_spot_usd,
  );
  if (moneyness !== 'otm') reason_codes.push(`not_otm_${moneyness}`);
  return {
    ...record,
    candidate_spot_usd: Number.isFinite(candidate_spot_usd) ? candidate_spot_usd : null,
    moneyness,
    quality_complete: reason_codes.length === 0,
    quality_reason_codes: [...new Set(reason_codes)],
  };
}

function same_strike_groups(events, minimum_event_count) {
  const grouped = new Map();
  for (const event of events) {
    const strike_usd = rounded(event.strike_usd, 4);
    const key = `${event.option_right}:${strike_usd}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        option_right: event.option_right,
        strike_usd,
        event_count: 0,
        premium_usd: 0,
        source_message_ids: [],
        source_event_ids: [],
        events: [],
      });
    }
    const group = grouped.get(key);
    group.event_count += 1;
    group.premium_usd += event.premium_usd;
    group.events.push(event);
    if (event.source_message_id) group.source_message_ids.push(event.source_message_id);
    if (event.source_event_id) group.source_event_ids.push(event.source_event_id);
  }
  return [...grouped.values()].map((group) => ({
    ...group,
    premium_usd: rounded(group.premium_usd, 2),
    repeated: group.event_count >= minimum_event_count,
    source_message_ids: [...new Set(group.source_message_ids)],
    source_event_ids: [...new Set(group.source_event_ids)],
  }));
}

function group_events(groups, option_right) {
  return groups
    .filter((group) => group.repeated && group.option_right === option_right)
    .flatMap((group) => group.events);
}

function quality_reason_counts(assessments) {
  const counts = {};
  for (const assessment of assessments) {
    for (const reason of assessment.quality_reason_codes || []) increment_reason(counts, reason);
  }
  return counts;
}

function evaluate_ticker(
  aggregate,
  candidate_direction,
  thresholds,
  candidate_spot_usd,
  { auxiliary_only = false } = {},
) {
  const supportive_right = candidate_direction === 'bull' ? 'call' : 'put';
  const opposite_right = supportive_right === 'call' ? 'put' : 'call';
  const assessments = (Array.isArray(aggregate?.event_records) ? aggregate.event_records : [])
    .map((record) => quality_assessment(record, candidate_spot_usd, thresholds));
  const quality_events = assessments.filter((event) => event.quality_complete);
  const strike_groups = same_strike_groups(
    quality_events,
    thresholds.min_same_strike_event_count,
  );
  const supportive_events = group_events(strike_groups, supportive_right);
  const opposite_events = group_events(strike_groups, opposite_right);
  const supportive_event_count = supportive_events.length;
  const opposite_event_count = opposite_events.length;
  const supportive_premium_usd = supportive_events.reduce((sum, event) => sum + event.premium_usd, 0);
  const opposite_premium_usd = opposite_events.reduce((sum, event) => sum + event.premium_usd, 0);
  const supportive_to_opposite_ratio = ratio_for_threshold(
    supportive_premium_usd,
    opposite_premium_usd,
  );
  const opposite_to_supportive_ratio = ratio_for_threshold(
    opposite_premium_usd,
    supportive_premium_usd,
  );

  const strong_opposite = opposite_event_count >= thresholds.min_opposite_event_count
    && opposite_premium_usd >= thresholds.min_opposite_premium_usd
    && opposite_to_supportive_ratio >= thresholds.min_opposite_to_supportive_ratio;
  const strong_support = supportive_event_count >= thresholds.min_confirming_event_count
    && supportive_premium_usd >= thresholds.min_confirming_premium_usd
    && supportive_to_opposite_ratio >= thresholds.min_confirming_supportive_to_opposite_ratio;
  const raw_decision = strong_opposite && strong_support
    ? 'neutral'
    : strong_opposite
      ? 'conflict_veto'
      : strong_support
        ? 'confirm'
        : 'neutral';
  const decision = auxiliary_only ? 'neutral' : raw_decision;
  const decision_events = raw_decision === 'confirm'
    ? supportive_events
    : raw_decision === 'conflict_veto'
      ? opposite_events
      : [];
  return {
    decision,
    raw_decision,
    auxiliary_only,
    decision_quality_complete: !auxiliary_only && decision !== 'neutral',
    directional_bias: aggregate.directional_bias,
    supportive_right,
    opposite_right,
    supportive_event_count,
    opposite_event_count,
    supportive_premium_usd,
    opposite_premium_usd,
    supportive_to_opposite_ratio: ratio_for_output(supportive_premium_usd, opposite_premium_usd),
    opposite_to_supportive_ratio: ratio_for_output(opposite_premium_usd, supportive_premium_usd),
    supportive_ratio_unbounded: supportive_premium_usd > 0 && opposite_premium_usd <= 0,
    opposite_ratio_unbounded: opposite_premium_usd > 0 && supportive_premium_usd <= 0,
    quality_event_count: quality_events.length,
    quality_incomplete_event_count: assessments.length - quality_events.length,
    repeated_strike_group_count: strike_groups.filter((group) => group.repeated).length,
    strike_groups: strike_groups.map(({ events: _events, ...group }) => group),
    quality_reason_counts: quality_reason_counts(assessments),
    decision_source_message_ids: [...new Set(
      decision_events.map((event) => event.source_message_id).filter(Boolean),
    )],
    decision_source_event_ids: [...new Set(
      decision_events.map((event) => event.source_event_id).filter(Boolean),
    )],
    source_message_ids: [...(aggregate?.source_message_ids || [])],
    source_event_ids: [...(aggregate?.source_event_ids || [])],
  };
}

/**
 * Evaluate Flow only as confirmation/veto context for an already-existing
 * bull/bear candidate. No candidate means no output direction, and this
 * function never creates a signal or an order intent.
 */
export function evaluate_junk_flow_candidate({
  flow_context,
  candidate_direction,
  candidate_spot_usd,
  candidate_last_price_usd,
  spy_spot_usd,
  reference_prices,
  candidate,
  window_seconds,
  policy = {},
} = {}) {
  const direction = normalized_candidate_direction(candidate_direction);
  if (!direction) throw new TypeError('candidate_direction must be bull or bear');
  const thresholds = normalized_policy(policy);
  const spot_usd = resolved_candidate_spot({
    candidate_spot_usd: candidate_spot_usd ?? reference_prices?.spx,
    candidate_last_price_usd,
    candidate,
  });
  const resolved_spy_spot_usd = positive_number(spy_spot_usd ?? reference_prices?.spy);
  const selected_window_seconds = bounded_integer(
    window_seconds,
    thresholds.evaluation_window_seconds,
  );
  if (!DEFAULT_WINDOW_SECONDS.includes(selected_window_seconds)) {
    throw new RangeError('window_seconds must be 60 or 180');
  }
  const base = {
    candidate_direction: direction,
    decision: 'neutral',
    window_seconds: selected_window_seconds,
    availability_status: normalized_token(flow_context?.availability_status) || 'missing',
    ticker_results: {
      spx: null,
      spy: null,
    },
    source_message_ids: [],
    source_event_ids: [],
    decision_source_message_ids: [],
    decision_source_event_ids: [],
    decision_evidence_ticker: null,
    candidate_spot_usd: spot_usd,
    spy_spot_usd: resolved_spy_spot_usd,
    quality_rule: 'live_0dte_spx_large_otm_same_strike_sweep',
    quality_complete: false,
    can_trigger_trade: false,
    can_veto_candidate: false,
    reason_codes: [],
  };
  if (!flow_context || typeof flow_context !== 'object') {
    base.reason_codes.push('flow_context_missing');
    return base;
  }
  if (flow_context.availability_status === 'missing') {
    base.reason_codes.push('flow_source_missing');
    return base;
  }
  if (flow_context.availability_status === 'disconnected') {
    base.reason_codes.push('flow_source_disconnected');
    return base;
  }
  const window = flow_context.windows?.[`window_${selected_window_seconds}s`];
  if (!window) {
    base.reason_codes.push('flow_window_missing');
    return base;
  }
  base.source_message_ids = [...window.source_message_ids];
  base.source_event_ids = [...window.source_event_ids];

  const spx = evaluate_ticker(window.tickers.spx, direction, thresholds, spot_usd);
  const spy = evaluate_ticker(
    window.tickers.spy,
    direction,
    thresholds,
    resolved_spy_spot_usd,
    { auxiliary_only: true },
  );
  base.ticker_results = { spx, spy };
  if (window.event_count < 2) {
    base.reason_codes.push(window.event_count === 0 ? 'flow_neutral' : 'single_flow_event_neutral');
    return base;
  }
  if (!Number.isFinite(spot_usd)) {
    base.reason_codes.push('candidate_spot_missing_quality_neutral');
    return base;
  }
  if (spx.raw_decision === 'neutral' && spx.quality_event_count === 0) {
    base.reason_codes.push(
      spy.quality_event_count > 0
        ? 'spy_auxiliary_only_neutral'
        : 'spx_flow_quality_incomplete_neutral',
    );
    return base;
  }
  if (spx.raw_decision === 'neutral' && spx.repeated_strike_group_count === 0) {
    base.reason_codes.push('spx_same_strike_repetition_missing_neutral');
    return base;
  }
  if (spx.raw_decision === 'conflict_veto') {
    base.decision = 'conflict_veto';
    base.quality_complete = true;
    base.can_veto_candidate = true;
    base.decision_evidence_ticker = 'spx';
    base.decision_source_message_ids = [...spx.decision_source_message_ids];
    base.decision_source_event_ids = [...spx.decision_source_event_ids];
    base.reason_codes.push('spx_large_otm_same_strike_sweep_conflict_veto');
    return base;
  }
  if (spx.raw_decision === 'confirm') {
    base.decision = 'confirm';
    base.quality_complete = true;
    base.decision_evidence_ticker = 'spx';
    base.decision_source_message_ids = [...spx.decision_source_message_ids];
    base.decision_source_event_ids = [...spx.decision_source_event_ids];
    base.reason_codes.push('spx_large_otm_same_strike_sweep_confirmed');
    return base;
  }
  base.reason_codes.push('flow_neutral');
  return base;
}

function normalized_evaluation_windows(windows_seconds) {
  const requested = Array.isArray(windows_seconds) ? windows_seconds : [windows_seconds];
  const valid = requested
    .map((value) => Number(value))
    .filter((value) => DEFAULT_WINDOW_SECONDS.includes(value));
  const unique = [...new Set(valid)];
  return unique.length > 0 ? unique : [...DEFAULT_WINDOW_SECONDS];
}

/**
 * Pure precedence merge for already-computed window evaluations. The merged
 * result remains context for an existing candidate; it cannot create one.
 */
export function merge_junk_flow_window_evaluations(evaluations = []) {
  const valid = (Array.isArray(evaluations) ? evaluations : [])
    .filter((evaluation) => evaluation && typeof evaluation === 'object');
  const per_window = {};
  const source_message_ids = new Set();
  const source_event_ids = new Set();
  const reason_codes = new Set();
  for (const evaluation of valid) {
    const window_seconds = Number(evaluation.window_seconds);
    if (DEFAULT_WINDOW_SECONDS.includes(window_seconds)) {
      per_window[`window_${window_seconds}s`] = evaluation;
    }
    for (const id of evaluation.source_message_ids || []) source_message_ids.add(String(id));
    for (const id of evaluation.source_event_ids || []) source_event_ids.add(String(id));
    for (const reason of evaluation.reason_codes || []) reason_codes.add(String(reason));
  }
  const quality_valid = valid.filter((evaluation) => (
    evaluation.quality_complete === true
    && normalized_token(evaluation.decision_evidence_ticker) === 'spx'
  ));
  const decisions = quality_valid.map((evaluation) => normalized_token(evaluation.decision));
  const decision = decisions.includes('conflict_veto')
    ? 'conflict_veto'
    : decisions.includes('confirm')
      ? 'confirm'
      : 'neutral';
  const winning_evaluations = quality_valid.filter((evaluation) => (
    normalized_token(evaluation.decision) === decision
  ));
  const decision_source_message_ids = new Set();
  const decision_source_event_ids = new Set();
  for (const evaluation of winning_evaluations) {
    for (const id of evaluation.decision_source_message_ids || []) {
      decision_source_message_ids.add(String(id));
    }
    for (const id of evaluation.decision_source_event_ids || []) {
      decision_source_event_ids.add(String(id));
    }
  }
  return {
    candidate_direction: valid[0]?.candidate_direction || null,
    decision,
    availability_status: valid[0]?.availability_status || 'missing',
    evaluated_windows_seconds: Object.values(per_window)
      .map((evaluation) => Number(evaluation.window_seconds)),
    source_message_ids: [...source_message_ids],
    source_event_ids: [...source_event_ids],
    decision_source_message_ids: [...decision_source_message_ids],
    decision_source_event_ids: [...decision_source_event_ids],
    decision_evidence_ticker: decision === 'neutral' ? null : 'spx',
    candidate_spot_usd: valid.find((evaluation) => Number.isFinite(evaluation.candidate_spot_usd))
      ?.candidate_spot_usd ?? null,
    quality_rule: 'live_0dte_spx_large_otm_same_strike_sweep',
    quality_complete: decision !== 'neutral',
    can_trigger_trade: false,
    can_veto_candidate: decision === 'conflict_veto',
    reason_codes: [...reason_codes],
    per_window,
  };
}

export const combine_junk_flow_evaluations = merge_junk_flow_window_evaluations;

export function evaluate_junk_flow_windows({
  flow_context,
  candidate_direction,
  candidate_spot_usd,
  candidate_last_price_usd,
  spy_spot_usd,
  reference_prices,
  candidate,
  windows_seconds = DEFAULT_WINDOW_SECONDS,
  policy = {},
} = {}) {
  const evaluations = normalized_evaluation_windows(windows_seconds)
    .map((window_seconds) => evaluate_junk_flow_candidate({
      flow_context,
      candidate_direction,
      candidate_spot_usd,
      candidate_last_price_usd,
      spy_spot_usd,
      reference_prices,
      candidate,
      window_seconds,
      policy,
    }));
  return merge_junk_flow_window_evaluations(evaluations);
}

function resolved_connected(source_connected, override) {
  if (typeof override === 'boolean') return override;
  if (typeof source_connected === 'function') {
    try {
      return source_connected() === true;
    } catch {
      return false;
    }
  }
  return source_connected !== false;
}

export function create_junk_flow_context({
  file_path = 'logs/zero-dte-options-flow-events.ndjson',
  fs_module = fs,
  now_ms = () => Date.now(),
  source_connected = true,
  policy = {},
} = {}) {
  const resolved_policy = normalized_policy(policy);
  function build_context({ source_connected: connected_override } = {}) {
    const tail = read_bounded_ndjson_tail({
      file_path,
      fs_module,
      max_tail_bytes: resolved_policy.max_tail_bytes,
      max_tail_rows: resolved_policy.max_tail_rows,
    });
    return build_junk_flow_context({
      events: tail.events,
      now_ms: resolve_now_ms(now_ms),
      source_present: tail.diagnostics.file_exists,
      source_connected: resolved_connected(source_connected, connected_override),
      tail_diagnostics: tail.diagnostics,
      policy: resolved_policy,
    });
  }
  return {
    build_context,
    evaluate({
      candidate_direction,
      candidate_spot_usd,
      candidate_last_price_usd,
      spy_spot_usd,
      reference_prices,
      candidate,
      flow_context,
      window_seconds,
    } = {}) {
      const resolved_context = flow_context || build_context();
      return evaluate_junk_flow_candidate({
        flow_context: resolved_context,
        candidate_direction,
        candidate_spot_usd,
        candidate_last_price_usd,
        spy_spot_usd,
        reference_prices,
        candidate,
        window_seconds,
        policy: resolved_policy,
      });
    },
    evaluate_windows({
      candidate_direction,
      candidate_spot_usd,
      candidate_last_price_usd,
      spy_spot_usd,
      reference_prices,
      candidate,
      flow_context,
      windows_seconds,
    } = {}) {
      const resolved_context = flow_context || build_context();
      return evaluate_junk_flow_windows({
        flow_context: resolved_context,
        candidate_direction,
        candidate_spot_usd,
        candidate_last_price_usd,
        spy_spot_usd,
        reference_prices,
        candidate,
        windows_seconds,
        policy: resolved_policy,
      });
    },
  };
}
