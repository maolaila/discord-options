const NEW_YORK_TIME_ZONE = 'America/New_York';

export const NIGHTWATCH_FIXED_SAMPLE_INTERVAL_MS = 5 * 60_000;
// Public Dealer GEX/Heatmap timestamps identify the start of a five-minute
// bucket.  The latest completed bucket is therefore normally between five and
// ten minutes old until the next bucket replaces it.  Ten minutes, inclusive,
// accepts only that latest completed bucket; the API contract returns 503
// rather than falling back when the currently expected bucket is unavailable.
export const NIGHTWATCH_FIXED_SAMPLE_MAX_AGE_MS = 2 * NIGHTWATCH_FIXED_SAMPLE_INTERVAL_MS;
export const JUNK_GEX_MAX_AGE_MS = NIGHTWATCH_FIXED_SAMPLE_MAX_AGE_MS;
export const JUNK_GEX_FUTURE_TOLERANCE_MS = 5_000;

function timestamp_ms(value) {
  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function finite_number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function date_key_in_new_york(value_ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NEW_YORK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value_ms));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function valid_date_key(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = Date.parse(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === text
    ? text
    : null;
}

function source_payload(response) {
  if (response?.data && typeof response.data === 'object' && !Array.isArray(response.data)) {
    return response.data;
  }
  return response && typeof response === 'object' && !Array.isArray(response) ? response : {};
}

function normalized_cache_hit(value) {
  return typeof value === 'boolean' ? value : null;
}

function previous_snapshot_ms(previous_observation) {
  return timestamp_ms(
    previous_observation?.source_snapshot_at
    ?? previous_observation?.snapshot_at,
  );
}

function previous_advanced_at(previous_observation) {
  const value = previous_observation?.last_advanced_at
    ?? previous_observation?.observed_at;
  const parsed = timestamp_ms(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

/**
 * Evaluate one raw Nightwatch Dealer GEX response without mutating runtime state.
 *
 * The fixed-sample maximum age and five-second future tolerance are constants
 * rather than options. This diagnostic must never become a second, looser
 * policy surface.
 */
export function assess_junk_gex_freshness({
  response,
  observed_at = new Date(),
  previous_observation = null,
} = {}) {
  const observed_at_ms = timestamp_ms(observed_at);
  if (observed_at_ms === null) throw new TypeError('observed_at must be a valid timestamp');

  const observed_at_iso = new Date(observed_at_ms).toISOString();
  const current_session_date_et = date_key_in_new_york(observed_at_ms);
  const payload = source_payload(response);
  const provider_state = String(payload.state || '').trim().toLowerCase() || null;
  const source_snapshot_at_ms = timestamp_ms(payload.snapshot_at);
  const source_snapshot_at = source_snapshot_at_ms === null
    ? null
    : new Date(source_snapshot_at_ms).toISOString();
  const session_date_et = valid_date_key(payload.session_date_et);
  const meta_freshness_seconds = finite_number(response?._meta?.data_freshness_seconds);
  const source_age_ms = source_snapshot_at_ms === null
    ? null
    : observed_at_ms - source_snapshot_at_ms;
  const meta_age_ms = meta_freshness_seconds === null
    ? null
    : meta_freshness_seconds * 1_000;
  const effective_age_ms = source_age_ms === null || meta_age_ms === null
    ? null
    : Math.max(source_age_ms, meta_age_ms);

  const reason_codes = [];
  if (provider_state !== 'fresh') reason_codes.push('provider_state_not_fresh');

  if (source_snapshot_at_ms === null) {
    reason_codes.push('missing_or_invalid_snapshot_at');
  } else {
    if (source_age_ms < -JUNK_GEX_FUTURE_TOLERANCE_MS) {
      reason_codes.push('source_snapshot_future');
    }
    if (source_age_ms > JUNK_GEX_MAX_AGE_MS) {
      reason_codes.push('source_age_exceeded');
    }
  }

  if (!session_date_et) {
    reason_codes.push('missing_or_invalid_session_date_et');
  } else if (session_date_et !== current_session_date_et) {
    reason_codes.push('cross_session_snapshot');
  }

  if (meta_age_ms === null) {
    reason_codes.push('missing_or_invalid_meta_freshness');
  } else {
    if (meta_age_ms < -JUNK_GEX_FUTURE_TOLERANCE_MS) {
      reason_codes.push('meta_freshness_future');
    }
    if (meta_age_ms > JUNK_GEX_MAX_AGE_MS) {
      reason_codes.push('meta_age_exceeded');
    }
  }

  const prior_snapshot_at_ms = previous_snapshot_ms(previous_observation);
  const same_snapshot = source_snapshot_at_ms !== null
    && prior_snapshot_at_ms !== null
    && source_snapshot_at_ms === prior_snapshot_at_ms;
  const source_regressed = source_snapshot_at_ms !== null
    && prior_snapshot_at_ms !== null
    && source_snapshot_at_ms < prior_snapshot_at_ms;

  if (source_regressed) reason_codes.push('source_snapshot_regressed');

  let consecutive_same_snapshot_count = source_snapshot_at_ms === null ? 0 : 1;
  if (same_snapshot) {
    const previous_count = Number(previous_observation?.consecutive_same_snapshot_count);
    consecutive_same_snapshot_count = Number.isInteger(previous_count) && previous_count >= 1
      ? previous_count + 1
      : 2;
  }

  let last_advanced_at = null;
  if (source_snapshot_at_ms !== null) {
    if (prior_snapshot_at_ms === null || source_snapshot_at_ms > prior_snapshot_at_ms) {
      last_advanced_at = observed_at_iso;
    } else {
      last_advanced_at = previous_advanced_at(previous_observation);
    }
  }

  return {
    observed_at: observed_at_iso,
    source_snapshot_at,
    session_date_et: session_date_et || payload.session_date_et || null,
    current_session_date_et,
    provider_state,
    max_age_ms: JUNK_GEX_MAX_AGE_MS,
    future_tolerance_ms: JUNK_GEX_FUTURE_TOLERANCE_MS,
    source_age_ms,
    meta_age_ms,
    effective_age_ms,
    cache_hit: normalized_cache_hit(response?._meta?.cache_hit),
    readiness: reason_codes.length === 0 ? 'ready' : 'not_ready',
    reason_codes: [...new Set(reason_codes)],
    consecutive_same_snapshot_count,
    last_advanced_at,
    source_stalled: same_snapshot,
  };
}
