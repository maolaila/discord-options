const MINUTE_MS = 60_000;
const FIVE_MINUTE_MS = 5 * MINUTE_MS;

export const DEFAULT_JUNK_GEX_CONTEXT_LIMITS = Object.freeze({
  max_samples: 1_200,
  max_bars_1m: 120,
  max_anchor_spy_gap_ms: 5_000,
  max_latest_spy_quote_age_ms: 3_000,
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

function nonnegative_number(value) {
  const parsed = finite_number(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function positive_integer(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonnegative_integer(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return parsed;
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

function snapshot_payload(snapshot) {
  if (snapshot?.data && typeof snapshot.data === 'object') return snapshot.data;
  return snapshot && typeof snapshot === 'object' ? snapshot : {};
}

const FIXED_SAMPLE_INTERVAL_MS = 5 * 60_000;
const FIXED_SAMPLE_LAST_ARCHIVE_OFFSET_MS = FIXED_SAMPLE_INTERVAL_MS - 1_000;

/**
 * Public fixed-sample snapshots label a bucket with its start time even though
 * spot_usd is the last archived version from the bucket's final minute. Keep
 * the source timestamp for GEX identity/history and derive a separate SPY
 * alignment time at the end of that final minute. Legacy non-boundary
 * timestamps retain their original alignment semantics.
 */
export function gex_spot_alignment_at(snapshot_at) {
  const source_ms = timestamp_ms(snapshot_at);
  if (source_ms === null) return null;
  const alignment_ms = source_ms % FIXED_SAMPLE_INTERVAL_MS === 0
    ? source_ms + FIXED_SAMPLE_LAST_ARCHIVE_OFFSET_MS
    : source_ms;
  return new Date(alignment_ms).toISOString();
}

/**
 * Normalize a Nightwatch dealer-GEX SPX snapshot into the small, secret-free
 * anchor shape persisted by this business line. These anchors never create
 * price-action bars.
 */
export function normalize_spx_spot_sample(snapshot) {
  const source = snapshot_payload(snapshot);
  const ticker = String(source.ticker || snapshot?.ticker || 'SPX').trim().toUpperCase();
  if (ticker !== 'SPX') return null;

  const snapshot_at = iso_timestamp(
    source.snapshot_at
      ?? source.sample_at
      ?? source.timestamp
      ?? snapshot?.snapshot_at
      ?? snapshot?.sample_at
      ?? snapshot?.timestamp,
  );
  const spot_usd = positive_number(
    source.spot_usd
      ?? source.spot_price_usd
      ?? source.spot
      ?? snapshot?.spot_usd
      ?? snapshot?.spot_price_usd
      ?? snapshot?.spot,
  );
  if (!snapshot_at || spot_usd === null) return null;

  return {
    ticker: 'SPX',
    snapshot_at,
    spot_alignment_at: gex_spot_alignment_at(snapshot_at),
    spot_usd,
  };
}

function spy_basic_payload(snapshot) {
  if (snapshot?.basic && typeof snapshot.basic === 'object') return snapshot.basic;
  return {};
}

function spy_average_price(basic) {
  const explicit = positive_number(basic.avg_price ?? basic.avgPrice);
  if (explicit !== null) return explicit;
  const turnover = positive_number(basic.turnover);
  const volume = positive_number(basic.hp_volume ?? basic.hpVolume ?? basic.volume);
  return turnover !== null && volume !== null ? turnover / volume : null;
}

/**
 * Normalize one timestamped moomoo SPY quote. `quote_received_at` is used as
 * event time; polling time is deliberately not substituted because doing so
 * would turn an old cached quote into a fresh price-action observation.
 */
export function normalize_spy_quote_sample(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const basic = spy_basic_payload(snapshot);
  const security_code = String(
    basic.security?.code
      ?? basic.code
      ?? snapshot.ticker
      ?? 'SPY',
  ).trim().toUpperCase();
  if (security_code !== 'SPY') return null;

  const quote_received_at = iso_timestamp(snapshot.quote_received_at);
  const cur_price_usd = positive_number(basic.cur_price ?? basic.curPrice);
  if (!quote_received_at || cur_price_usd === null) return null;

  return {
    ticker: 'SPY',
    quote_received_at,
    cur_price_usd,
    avg_price_usd: rounded(spy_average_price(basic)),
    cumulative_volume: nonnegative_number(basic.hp_volume ?? basic.hpVolume ?? basic.volume),
  };
}

function normalize_restored_spy_sample(sample) {
  const normalized = normalize_spy_quote_sample(sample);
  if (normalized) return normalized;
  if (!sample || typeof sample !== 'object') return null;
  if (String(sample.ticker || 'SPY').trim().toUpperCase() !== 'SPY') return null;
  const quote_received_at = iso_timestamp(sample.quote_received_at ?? sample.snapshot_at);
  const cur_price_usd = positive_number(sample.cur_price_usd ?? sample.spot_usd);
  if (!quote_received_at || cur_price_usd === null) return null;
  return {
    ticker: 'SPY',
    quote_received_at,
    cur_price_usd,
    avg_price_usd: positive_number(sample.avg_price_usd),
    cumulative_volume: nonnegative_number(sample.cumulative_volume),
  };
}

function normalize_closed_bar(bar) {
  if (!bar || typeof bar !== 'object') return null;
  const minute_start_ms = timestamp_ms(bar.minute_start_at ?? bar.timestamp ?? bar.time);
  const open_usd = positive_number(bar.open_usd);
  const high_usd = positive_number(bar.high_usd);
  const low_usd = positive_number(bar.low_usd);
  const close_usd = positive_number(bar.close_usd);
  if (
    minute_start_ms === null
    || open_usd === null
    || high_usd === null
    || low_usd === null
    || close_usd === null
  ) return null;

  const normalized_start_ms = Math.floor(minute_start_ms / MINUTE_MS) * MINUTE_MS;
  const sample_count = Math.max(1, Math.trunc(finite_number(bar.sample_count) || 1));
  const volume = nonnegative_number(bar.volume);
  return {
    timestamp: new Date(normalized_start_ms).toISOString(),
    minute_start_at: new Date(normalized_start_ms).toISOString(),
    minute_end_at: new Date(normalized_start_ms + MINUTE_MS).toISOString(),
    open_usd,
    high_usd: Math.max(high_usd, open_usd, close_usd),
    low_usd: Math.min(low_usd, open_usd, close_usd),
    close_usd,
    sample_count,
    volume,
    first_sample_at: iso_timestamp(bar.first_sample_at) || new Date(normalized_start_ms).toISOString(),
    last_sample_at: iso_timestamp(bar.last_sample_at) || new Date(normalized_start_ms).toISOString(),
  };
}

function normalize_generic_samples(samples) {
  const by_timestamp = new Map();
  for (const raw_sample of Array.isArray(samples) ? samples : []) {
    const snapshot_at = iso_timestamp(
      raw_sample?.snapshot_at
        ?? raw_sample?.quote_received_at,
    );
    const spot_usd = positive_number(
      raw_sample?.spot_usd
        ?? raw_sample?.cur_price_usd,
    );
    if (!snapshot_at || spot_usd === null) continue;
    by_timestamp.set(timestamp_ms(snapshot_at), {
      snapshot_at,
      spot_usd,
      cumulative_volume: nonnegative_number(raw_sample?.cumulative_volume),
    });
  }
  return [...by_timestamp.values()]
    .sort((left, right) => timestamp_ms(left.snapshot_at) - timestamp_ms(right.snapshot_at));
}

function normalize_bars(bars_1m) {
  const by_minute = new Map();
  for (const raw_bar of Array.isArray(bars_1m) ? bars_1m : []) {
    const bar = normalize_closed_bar(raw_bar);
    if (!bar) continue;
    by_minute.set(timestamp_ms(bar.minute_start_at), bar);
  }
  return [...by_minute.values()]
    .sort((left, right) => timestamp_ms(left.minute_start_at) - timestamp_ms(right.minute_start_at));
}

function bar_from_samples(minute_start_ms, samples) {
  const ordered = [...samples]
    .sort((left, right) => timestamp_ms(left.snapshot_at) - timestamp_ms(right.snapshot_at));
  const prices = ordered.map((sample) => sample.spot_usd);
  const volumes = ordered
    .map((sample) => nonnegative_number(sample.cumulative_volume))
    .filter((value) => value !== null);
  const volume = volumes.length >= 2
    ? Math.max(0, volumes.at(-1) - volumes[0])
    : null;
  return {
    timestamp: new Date(minute_start_ms).toISOString(),
    minute_start_at: new Date(minute_start_ms).toISOString(),
    minute_end_at: new Date(minute_start_ms + MINUTE_MS).toISOString(),
    open_usd: prices[0],
    high_usd: Math.max(...prices),
    low_usd: Math.min(...prices),
    close_usd: prices.at(-1),
    sample_count: ordered.length,
    volume,
    first_sample_at: ordered[0].snapshot_at,
    last_sample_at: ordered.at(-1).snapshot_at,
  };
}

function merge_partial_bar(existing, generated) {
  const existing_first_ms = timestamp_ms(existing.first_sample_at);
  const generated_first_ms = timestamp_ms(generated.first_sample_at);
  const existing_last_ms = timestamp_ms(existing.last_sample_at);
  const generated_last_ms = timestamp_ms(generated.last_sample_at);
  const first_is_generated = generated_first_ms < existing_first_ms;
  const last_is_generated = generated_last_ms > existing_last_ms;
  return {
    ...existing,
    open_usd: first_is_generated ? generated.open_usd : existing.open_usd,
    high_usd: Math.max(existing.high_usd, generated.high_usd),
    low_usd: Math.min(existing.low_usd, generated.low_usd),
    close_usd: last_is_generated ? generated.close_usd : existing.close_usd,
    sample_count: Math.max(existing.sample_count, generated.sample_count),
    volume: generated.volume === null
      ? existing.volume
      : Math.max(existing.volume ?? 0, generated.volume),
    first_sample_at: first_is_generated ? generated.first_sample_at : existing.first_sample_at,
    last_sample_at: last_is_generated ? generated.last_sample_at : existing.last_sample_at,
  };
}

/**
 * Aggregate generic timestamp/price samples into closed UTC epoch-minute bars.
 * The public helper remains compatible with existing callers. The context
 * builder only passes raw SPY quote samples to it.
 */
export function aggregate_closed_1m_bars({
  samples = [],
  bars_1m = [],
  now_ms = Date.now(),
  max_bars_1m = DEFAULT_JUNK_GEX_CONTEXT_LIMITS.max_bars_1m,
} = {}) {
  const resolved_now_ms = timestamp_ms(now_ms);
  if (resolved_now_ms === null) throw new TypeError('now_ms must be a valid timestamp');
  const resolved_max_bars = positive_integer(max_bars_1m, 'max_bars_1m');
  const current_minute_start_ms = Math.floor(resolved_now_ms / MINUTE_MS) * MINUTE_MS;
  const bars_by_minute = new Map();

  for (const bar of normalize_bars(bars_1m)) {
    const minute_start_ms = timestamp_ms(bar.minute_start_at);
    if (minute_start_ms < current_minute_start_ms) bars_by_minute.set(minute_start_ms, bar);
  }

  const samples_by_minute = new Map();
  for (const sample of normalize_generic_samples(samples)) {
    const sample_ms = timestamp_ms(sample.snapshot_at);
    const minute_start_ms = Math.floor(sample_ms / MINUTE_MS) * MINUTE_MS;
    if (minute_start_ms >= current_minute_start_ms) continue;
    const bucket = samples_by_minute.get(minute_start_ms) || [];
    bucket.push(sample);
    samples_by_minute.set(minute_start_ms, bucket);
  }

  for (const [minute_start_ms, minute_samples] of samples_by_minute) {
    const generated = bar_from_samples(minute_start_ms, minute_samples);
    const existing = bars_by_minute.get(minute_start_ms);
    bars_by_minute.set(
      minute_start_ms,
      existing && generated.sample_count < existing.sample_count
        ? merge_partial_bar(existing, generated)
        : generated,
    );
  }

  return [...bars_by_minute.values()]
    .sort((left, right) => timestamp_ms(left.minute_start_at) - timestamp_ms(right.minute_start_at))
    .slice(-resolved_max_bars);
}

/**
 * Build fully closed, aligned five-minute bars from raw one-minute SPY bars.
 * Incomplete buckets are deliberately omitted so an opening impulse or a
 * single wick can never masquerade as five-minute acceptance.
 */
export function aggregate_closed_5m_bars({
  bars_1m = [],
  now_ms = Date.now(),
  max_bars_5m = 24,
} = {}) {
  const resolved_now_ms = timestamp_ms(now_ms);
  if (resolved_now_ms === null) throw new TypeError('now_ms must be a valid timestamp');
  const limit = positive_integer(max_bars_5m, 'max_bars_5m');
  const grouped = new Map();
  for (const bar of normalize_bars(bars_1m)) {
    const start_ms = timestamp_ms(bar.minute_start_at);
    const bucket_start_ms = Math.floor(start_ms / FIVE_MINUTE_MS) * FIVE_MINUTE_MS;
    if (bucket_start_ms + FIVE_MINUTE_MS > resolved_now_ms) continue;
    const bucket = grouped.get(bucket_start_ms) || [];
    bucket.push(bar);
    grouped.set(bucket_start_ms, bucket);
  }

  const result = [];
  for (const [bucket_start_ms, raw_bucket] of grouped) {
    const bucket = [...raw_bucket].sort((left, right) => (
      timestamp_ms(left.minute_start_at) - timestamp_ms(right.minute_start_at)
    ));
    const expected = Array.from({ length: 5 }, (_value, index) => bucket_start_ms + index * MINUTE_MS);
    if (bucket.length !== 5 || bucket.some((bar, index) => timestamp_ms(bar.minute_start_at) !== expected[index])) {
      continue;
    }
    const volumes = bucket.map((bar) => nonnegative_number(bar.volume));
    result.push({
      timestamp: new Date(bucket_start_ms).toISOString(),
      minute_start_at: new Date(bucket_start_ms).toISOString(),
      minute_end_at: new Date(bucket_start_ms + FIVE_MINUTE_MS).toISOString(),
      open_usd: bucket[0].open_usd,
      high_usd: Math.max(...bucket.map((bar) => bar.high_usd)),
      low_usd: Math.min(...bucket.map((bar) => bar.low_usd)),
      close_usd: bucket.at(-1).close_usd,
      sample_count: bucket.reduce((sum, bar) => sum + bar.sample_count, 0),
      volume: volumes.every((value) => value !== null)
        ? volumes.reduce((sum, value) => sum + value, 0)
        : null,
      first_sample_at: bucket[0].first_sample_at,
      last_sample_at: bucket.at(-1).last_sample_at,
    });
  }
  return result
    .sort((left, right) => timestamp_ms(left.minute_start_at) - timestamp_ms(right.minute_start_at))
    .slice(-limit);
}

/**
 * Compatibility helper for callers that already have a contemporaneous SPX
 * anchor and SPY quote. Context construction uses the same formula with the
 * anchor-aligned SPY sample.
 */
export function map_spy_vwap_to_spx({
  spx_spot_usd,
  spy_basic,
  spy_snapshot,
} = {}) {
  const basic = spy_basic && typeof spy_basic === 'object'
    ? spy_basic
    : spy_basic_payload(spy_snapshot);
  const spot_usd = positive_number(spx_spot_usd);
  const spy_avg_price_usd = spy_average_price(basic);
  const spy_cur_price_usd = positive_number(basic.cur_price ?? basic.curPrice);
  if (spot_usd === null || spy_avg_price_usd === null || spy_cur_price_usd === null) return null;
  return rounded(spot_usd * (spy_avg_price_usd / spy_cur_price_usd));
}

function clock_value(clock, override) {
  const value = override ?? clock();
  const parsed = timestamp_ms(value);
  if (parsed === null) throw new TypeError('clock returned an invalid timestamp');
  return parsed;
}

function mapped_bar(bar, ratio) {
  return {
    ...bar,
    open_usd: rounded(bar.open_usd * ratio),
    high_usd: rounded(bar.high_usd * ratio),
    low_usd: rounded(bar.low_usd * ratio),
    close_usd: rounded(bar.close_usd * ratio),
  };
}

/**
 * Stateful market-context builder.
 *
 * - `ingest_sample` is retained as the compatibility SPX-anchor interface.
 * - `ingest_spy_sample` is the only interface that feeds price-action bars.
 * - restored `spy_samples` and `spy_bars_1m` remain in raw SPY price units.
 */
export function create_junk_gex_market_context({
  samples = [],
  recent_samples = [],
  bars_1m = [],
  spx_anchor_samples = [],
  spy_samples = [],
  spy_bars_1m,
  max_samples = DEFAULT_JUNK_GEX_CONTEXT_LIMITS.max_samples,
  max_bars_1m = DEFAULT_JUNK_GEX_CONTEXT_LIMITS.max_bars_1m,
  max_anchor_spy_gap_ms = DEFAULT_JUNK_GEX_CONTEXT_LIMITS.max_anchor_spy_gap_ms,
  max_latest_spy_quote_age_ms = DEFAULT_JUNK_GEX_CONTEXT_LIMITS.max_latest_spy_quote_age_ms,
  now_ms = () => Date.now(),
} = {}) {
  if (typeof now_ms !== 'function') throw new TypeError('now_ms must be a function');
  const resolved_max_samples = positive_integer(max_samples, 'max_samples');
  const resolved_max_bars = positive_integer(max_bars_1m, 'max_bars_1m');
  const resolved_max_anchor_gap = nonnegative_integer(max_anchor_spy_gap_ms, 'max_anchor_spy_gap_ms');
  const resolved_max_quote_age = nonnegative_integer(
    max_latest_spy_quote_age_ms,
    'max_latest_spy_quote_age_ms',
  );
  const spx_anchor_by_timestamp = new Map();
  const spy_sample_by_timestamp = new Map();
  let raw_spy_bars = normalize_bars(
    Array.isArray(spy_bars_1m) ? spy_bars_1m : bars_1m,
  ).slice(-resolved_max_bars);

  for (const raw_anchor of [
    ...(Array.isArray(samples) ? samples : []),
    ...(Array.isArray(recent_samples) ? recent_samples : []),
    ...(Array.isArray(spx_anchor_samples) ? spx_anchor_samples : []),
  ]) {
    const anchor = normalize_spx_spot_sample(raw_anchor);
    if (anchor) spx_anchor_by_timestamp.set(timestamp_ms(anchor.snapshot_at), anchor);
  }
  for (const raw_sample of Array.isArray(spy_samples) ? spy_samples : []) {
    const sample = normalize_restored_spy_sample(raw_sample);
    if (sample) spy_sample_by_timestamp.set(timestamp_ms(sample.quote_received_at), sample);
  }

  function ordered_spx_anchors() {
    return [...spx_anchor_by_timestamp.values()]
      .sort((left, right) => timestamp_ms(left.snapshot_at) - timestamp_ms(right.snapshot_at));
  }

  function ordered_spy_samples() {
    return [...spy_sample_by_timestamp.values()]
      .sort((left, right) => timestamp_ms(left.quote_received_at) - timestamp_ms(right.quote_received_at));
  }

  function trim_map(map, ordered, timestamp_field) {
    for (const row of ordered.slice(0, Math.max(0, ordered.length - resolved_max_samples))) {
      map.delete(timestamp_ms(row[timestamp_field]));
    }
  }

  function refresh_raw_spy_bars(at_ms) {
    raw_spy_bars = aggregate_closed_1m_bars({
      samples: ordered_spy_samples().map((sample) => ({
        snapshot_at: sample.quote_received_at,
        spot_usd: sample.cur_price_usd,
        cumulative_volume: sample.cumulative_volume,
      })),
      bars_1m: raw_spy_bars,
      now_ms: at_ms,
      max_bars_1m: resolved_max_bars,
    });
    return raw_spy_bars;
  }

  function latest_at_or_before(rows, timestamp_field, at_ms) {
    return rows.filter((row) => timestamp_ms(row[timestamp_field]) <= at_ms).at(-1) || null;
  }

  function ingest_sample(snapshot, { at_ms } = {}) {
    const resolved_at_ms = clock_value(now_ms, at_ms);
    const anchor = normalize_spx_spot_sample(snapshot);
    if (!anchor) {
      refresh_raw_spy_bars(resolved_at_ms);
      return {
        accepted: false,
        duplicate: false,
        replaced: false,
        reason_code: 'invalid_spx_spot_sample',
        sample: null,
        closed_bar_count: raw_spy_bars.length,
        latest_closed_bar: raw_spy_bars.at(-1) || null,
      };
    }

    const key = timestamp_ms(anchor.snapshot_at);
    const previous = spx_anchor_by_timestamp.get(key) || null;
    const duplicate = previous?.spot_usd === anchor.spot_usd;
    const replaced = previous !== null && !duplicate;
    if (!duplicate) spx_anchor_by_timestamp.set(key, anchor);
    trim_map(spx_anchor_by_timestamp, ordered_spx_anchors(), 'snapshot_at');
    refresh_raw_spy_bars(resolved_at_ms);
    return {
      accepted: !duplicate,
      duplicate,
      replaced,
      reason_code: duplicate ? 'duplicate_sample' : (replaced ? 'sample_replaced' : 'sample_accepted'),
      sample: anchor,
      closed_bar_count: raw_spy_bars.length,
      latest_closed_bar: raw_spy_bars.at(-1) || null,
    };
  }

  function ingest_spy_sample(snapshot, { at_ms } = {}) {
    const resolved_at_ms = clock_value(now_ms, at_ms);
    const sample = normalize_spy_quote_sample(snapshot);
    if (!sample) {
      refresh_raw_spy_bars(resolved_at_ms);
      return {
        accepted: false,
        duplicate: false,
        replaced: false,
        reason_code: 'invalid_spy_quote_sample',
        sample: null,
        closed_bar_count: raw_spy_bars.length,
        latest_closed_bar: raw_spy_bars.at(-1) || null,
      };
    }

    const key = timestamp_ms(sample.quote_received_at);
    const previous = spy_sample_by_timestamp.get(key) || null;
    const duplicate = previous?.cur_price_usd === sample.cur_price_usd
      && previous?.avg_price_usd === sample.avg_price_usd;
    const replaced = previous !== null && !duplicate;
    if (!duplicate) spy_sample_by_timestamp.set(key, sample);
    refresh_raw_spy_bars(resolved_at_ms);
    trim_map(spy_sample_by_timestamp, ordered_spy_samples(), 'quote_received_at');
    return {
      accepted: !duplicate,
      duplicate,
      replaced,
      reason_code: duplicate
        ? 'duplicate_spy_sample'
        : (replaced ? 'spy_sample_replaced' : 'spy_sample_accepted'),
      sample,
      closed_bar_count: raw_spy_bars.length,
      latest_closed_bar: raw_spy_bars.at(-1) || null,
    };
  }

  function get_closed_bars({ at_ms } = {}) {
    const resolved_at_ms = clock_value(now_ms, at_ms);
    return refresh_raw_spy_bars(resolved_at_ms).map((bar) => ({ ...bar }));
  }

  function build_market_context({
    spx_snapshot,
    spy_basic,
    spy_snapshot,
    at_ms,
  } = {}) {
    const resolved_at_ms = clock_value(now_ms, at_ms);
    if (spx_snapshot !== undefined) ingest_sample(spx_snapshot, { at_ms: resolved_at_ms });
    if (spy_snapshot !== undefined) ingest_spy_sample(spy_snapshot, { at_ms: resolved_at_ms });

    const anchors = ordered_spx_anchors();
    const spy_rows = ordered_spy_samples();
    const anchor = latest_at_or_before(anchors, 'snapshot_at', resolved_at_ms);
    const latest_spy = latest_at_or_before(spy_rows, 'quote_received_at', resolved_at_ms);
    const raw_bars = refresh_raw_spy_bars(resolved_at_ms).map((bar) => ({ ...bar }));
    const raw_bars_5m = aggregate_closed_5m_bars({
      bars_1m: raw_bars,
      now_ms: resolved_at_ms,
      max_bars_5m: Math.max(3, Math.floor(resolved_max_bars / 5)),
    });
    const anchor_ms = timestamp_ms(anchor?.snapshot_at);
    const anchor_spot_alignment_ms = timestamp_ms(anchor?.spot_alignment_at ?? anchor?.snapshot_at);
    const anchor_spy = anchor_spot_alignment_ms === null
      ? null
      : spy_rows
        .filter((row) => timestamp_ms(row.quote_received_at) <= resolved_at_ms)
        .map((row) => ({
          row,
          gap_ms: Math.abs(timestamp_ms(row.quote_received_at) - anchor_spot_alignment_ms),
        }))
        .sort((left, right) => left.gap_ms - right.gap_ms)[0] || null;

    const anchor_spy_gap_ms = anchor_spy?.gap_ms ?? null;
    const anchor_aligned = anchor !== null
      && anchor_spy !== null
      && anchor_spy_gap_ms <= resolved_max_anchor_gap;
    const latest_spy_quote_age_ms = latest_spy === null
      ? null
      : resolved_at_ms - timestamp_ms(latest_spy.quote_received_at);
    const latest_spy_quote_fresh = latest_spy_quote_age_ms !== null
      && latest_spy_quote_age_ms >= 0
      && latest_spy_quote_age_ms <= resolved_max_quote_age;

    let readiness_reason_code = 'ready';
    if (!anchor) readiness_reason_code = 'missing_spx_anchor';
    else if (!anchor_spy || anchor_spy_gap_ms > resolved_max_anchor_gap) {
      readiness_reason_code = 'anchor_spy_sample_unavailable';
    } else if (!latest_spy) readiness_reason_code = 'missing_spy_quote';
    else if (latest_spy_quote_age_ms < 0) readiness_reason_code = 'future_spy_quote';
    else if (!latest_spy_quote_fresh) readiness_reason_code = 'stale_spy_quote';

    const price_action_ready = readiness_reason_code === 'ready';
    const ratio = anchor_aligned
      ? anchor.spot_usd / anchor_spy.row.cur_price_usd
      : null;
    const basic_avg = spy_basic && typeof spy_basic === 'object'
      ? spy_average_price(spy_basic)
      : null;
    const spy_avg_price_usd = latest_spy?.avg_price_usd ?? basic_avg;
    const mapped_bars = price_action_ready
      ? raw_bars.map((bar) => mapped_bar(bar, ratio))
      : [];
    const mapped_bars_5m = price_action_ready
      ? raw_bars_5m.map((bar) => mapped_bar(bar, ratio))
      : [];

    return {
      ticker: 'SPX',
      context_at: new Date(resolved_at_ms).toISOString(),
      price_action_source: 'moomoo_spy_push_mapped_to_spx',
      price_action_ready,
      readiness_reason_code,
      source_snapshot_at: anchor?.snapshot_at || null,
      anchor_source: 'nightwatch_dealer_gex_spx_spot',
      anchor_snapshot_at: anchor?.snapshot_at || null,
      anchor_spot_alignment_at: anchor?.spot_alignment_at || null,
      anchor_spot_usd: anchor?.spot_usd ?? null,
      anchor_age_ms: anchor_ms === null ? null : resolved_at_ms - anchor_ms,
      anchor_spy_quote_received_at: anchor_spy?.row.quote_received_at || null,
      anchor_spy_gap_ms,
      anchor_spy_gap_limit_ms: resolved_max_anchor_gap,
      latest_spy_quote_received_at: latest_spy?.quote_received_at || null,
      latest_spy_quote_age_ms,
      latest_spy_quote_age_limit_ms: resolved_max_quote_age,
      latest_spy_quote_fresh,
      last_price_usd: price_action_ready
        ? rounded(latest_spy.cur_price_usd * ratio)
        : null,
      vwap_usd: price_action_ready && spy_avg_price_usd !== null
        ? rounded(spy_avg_price_usd * ratio)
        : null,
      spy_avg_price_usd: spy_avg_price_usd ?? null,
      spy_cur_price_usd: latest_spy?.cur_price_usd ?? null,
      spy_to_spx_scale_ratio: ratio === null ? null : rounded(ratio, 8),
      raw_spy_bar_count: raw_bars.length,
      raw_spy_5m_bar_count: raw_bars_5m.length,
      bars_1m: mapped_bars,
      bars_5m: mapped_bars_5m,
    };
  }

  function export_state({ at_ms } = {}) {
    const resolved_at_ms = clock_value(now_ms, at_ms);
    const bars = refresh_raw_spy_bars(resolved_at_ms);
    const anchors = ordered_spx_anchors().map((sample) => ({ ...sample }));
    const raw_samples = ordered_spy_samples().map((sample) => ({ ...sample }));
    const raw_bars = bars.map((bar) => ({ ...bar }));
    return {
      schema_version: 2,
      exported_at: new Date(resolved_at_ms).toISOString(),
      samples: anchors,
      bars_1m: raw_bars,
      spx_anchor_samples: anchors,
      spy_samples: raw_samples,
      spy_bars_1m: raw_bars,
    };
  }

  return Object.freeze({
    ingest_sample,
    ingest_spy_sample,
    get_closed_bars,
    build_market_context,
    export_state,
  });
}
