export const NIGHTWATCH_FIXED_SAMPLE_INTERVAL_MS = 5 * 60_000;
export const NIGHTWATCH_READ_MODEL_MAX_ATTEMPTS = 3;

const TRACKER_STATUSES = new Set([
  'idle',
  'retry_wait',
  'succeeded',
  'terminal_error',
]);

function timestamp_ms(value) {
  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value_ms) {
  return value_ms === null ? null : new Date(value_ms).toISOString();
}

function aligned_bucket_ms(value) {
  const parsed = timestamp_ms(value);
  return parsed !== null && parsed % NIGHTWATCH_FIXED_SAMPLE_INTERVAL_MS === 0
    ? parsed
    : null;
}

function finite_nonnegative_integer(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function optional_timestamp_ms(value) {
  if (value === null || value === undefined) return null;
  return timestamp_ms(value);
}

/**
 * Return the start of the most recently completed fixed five-minute bucket.
 *
 * Nightwatch labels a sample with the bucket start. At 09:35:00 ET the 09:30
 * bucket has just completed, so epoch alignment is deliberately followed by
 * subtracting one full interval.
 */
export function expected_completed_bucket_at(now = new Date()) {
  const now_ms = timestamp_ms(now);
  if (now_ms === null) throw new TypeError('now must be a valid timestamp');
  const expected_ms = Math.floor(now_ms / NIGHTWATCH_FIXED_SAMPLE_INTERVAL_MS)
    * NIGHTWATCH_FIXED_SAMPLE_INTERVAL_MS
    - NIGHTWATCH_FIXED_SAMPLE_INTERVAL_MS;
  return iso(expected_ms);
}

export function fixed_sample_bucket_matches(actual_bucket_at, expected_bucket_at) {
  const actual_ms = aligned_bucket_ms(actual_bucket_at);
  const expected_ms = aligned_bucket_ms(expected_bucket_at);
  return actual_ms !== null && expected_ms !== null && actual_ms === expected_ms;
}

export function create_fixed_sample_tracker() {
  return {
    bucket_at: null,
    attempt_count: 0,
    status: 'idle',
    retry_due_at: null,
    last_success_bucket_at: null,
  };
}

function normalize_tracker(tracker) {
  if (tracker === null || tracker === undefined) return create_fixed_sample_tracker();
  if (typeof tracker !== 'object' || Array.isArray(tracker)) return null;

  const bucket_ms = tracker.bucket_at === null || tracker.bucket_at === undefined
    ? null
    : aligned_bucket_ms(tracker.bucket_at);
  const attempt_count = tracker.attempt_count === undefined
    ? 0
    : finite_nonnegative_integer(tracker.attempt_count);
  const status = tracker.status === undefined ? 'idle' : String(tracker.status);
  const retry_due_ms = optional_timestamp_ms(tracker.retry_due_at);
  const last_success_ms = tracker.last_success_bucket_at === null
    || tracker.last_success_bucket_at === undefined
    ? null
    : aligned_bucket_ms(tracker.last_success_bucket_at);

  if (
    (tracker.bucket_at !== null && tracker.bucket_at !== undefined && bucket_ms === null)
    || attempt_count === null
    || !TRACKER_STATUSES.has(status)
    || (tracker.retry_due_at !== null && tracker.retry_due_at !== undefined && retry_due_ms === null)
    || (
      tracker.last_success_bucket_at !== null
      && tracker.last_success_bucket_at !== undefined
      && last_success_ms === null
    )
  ) {
    return null;
  }

  if (bucket_ms === null) {
    if (attempt_count !== 0 || status !== 'idle' || retry_due_ms !== null) return null;
  } else if (attempt_count < 1 || status === 'idle') {
    return null;
  }

  if (status === 'retry_wait') {
    if (retry_due_ms === null || attempt_count >= NIGHTWATCH_READ_MODEL_MAX_ATTEMPTS) return null;
  } else if (retry_due_ms !== null) {
    return null;
  }

  if (status === 'succeeded' && last_success_ms !== bucket_ms) return null;
  if (last_success_ms !== null && bucket_ms !== null && last_success_ms > bucket_ms) return null;

  return {
    bucket_at: iso(bucket_ms),
    attempt_count,
    status,
    retry_due_at: iso(retry_due_ms),
    last_success_bucket_at: iso(last_success_ms),
  };
}

function session_gate({ session_open_minutes, ny_minutes }) {
  const has_open = session_open_minutes !== null && session_open_minutes !== undefined;
  const has_now = ny_minutes !== null && ny_minutes !== undefined;
  if (!has_open && !has_now) return { valid: true, open: true };
  if (!has_open || !has_now) return { valid: false, open: false };

  const open = Number(session_open_minutes);
  const current = Number(ny_minutes);
  if (
    !Number.isInteger(open)
    || !Number.isInteger(current)
    || open < 0
    || open >= 24 * 60
    || current < 0
    || current >= 24 * 60
  ) {
    return { valid: false, open: false };
  }
  return {
    valid: true,
    open: current >= open + NIGHTWATCH_FIXED_SAMPLE_INTERVAL_MS / 60_000,
  };
}

/**
 * Decide whether one endpoint should be requested now.
 *
 * Keep one tracker per endpoint. This function never mutates it. A malformed
 * tracker, incomplete session context, or clock regression fails closed.
 */
export function fixed_sample_request_due({
  now = new Date(),
  tracker = null,
  session_open_minutes = null,
  ny_minutes = null,
} = {}) {
  const now_ms = timestamp_ms(now);
  if (now_ms === null) throw new TypeError('now must be a valid timestamp');
  const expected_bucket_at = expected_completed_bucket_at(now_ms);
  const expected_ms = timestamp_ms(expected_bucket_at);
  const gate = session_gate({ session_open_minutes, ny_minutes });

  if (!gate.valid) {
    return { due: false, reason: 'invalid_session_context', expected_bucket_at };
  }
  if (!gate.open) {
    return { due: false, reason: 'before_first_completed_bucket', expected_bucket_at };
  }

  const current = normalize_tracker(tracker);
  if (!current) {
    return { due: false, reason: 'invalid_tracker', expected_bucket_at };
  }

  const tracked_bucket_ms = timestamp_ms(current.bucket_at);
  if (tracked_bucket_ms !== null && tracked_bucket_ms > expected_ms) {
    return { due: false, reason: 'clock_regressed', expected_bucket_at };
  }
  if (tracked_bucket_ms === null || tracked_bucket_ms < expected_ms) {
    return { due: true, reason: 'new_completed_bucket', expected_bucket_at };
  }

  if (current.status === 'succeeded') {
    return { due: false, reason: 'already_succeeded', expected_bucket_at };
  }
  if (current.status === 'terminal_error') {
    return { due: false, reason: 'waiting_for_next_bucket', expected_bucket_at };
  }
  if (current.status !== 'retry_wait') {
    return { due: false, reason: 'invalid_tracker', expected_bucket_at };
  }
  if (current.attempt_count >= NIGHTWATCH_READ_MODEL_MAX_ATTEMPTS) {
    return { due: false, reason: 'retry_exhausted', expected_bucket_at };
  }

  const retry_due_ms = timestamp_ms(current.retry_due_at);
  if (now_ms < retry_due_ms) {
    return { due: false, reason: 'read_model_retry_wait', expected_bucket_at };
  }
  return { due: true, reason: 'read_model_retry_due', expected_bucket_at };
}

/**
 * Record the result of one request and return a new tracker.
 *
 * Supported outcomes mirror the official API semantics. Only
 * READ_MODEL_UNAVAILABLE is retried inside the same bucket, and only when a
 * finite retry interval is supplied. All other failures wait for the next
 * completed bucket.
 */
export function record_fixed_sample_outcome({
  tracker = null,
  expected_bucket_at,
  attempted_at = new Date(),
  outcome,
  retry_after_ms = null,
} = {}) {
  const current = normalize_tracker(tracker);
  if (!current) throw new TypeError('tracker must be valid');

  const expected_ms = aligned_bucket_ms(expected_bucket_at);
  if (expected_ms === null) throw new TypeError('expected_bucket_at must be five-minute aligned');
  const attempted_ms = timestamp_ms(attempted_at);
  if (attempted_ms === null) throw new TypeError('attempted_at must be a valid timestamp');

  const tracked_bucket_ms = timestamp_ms(current.bucket_at);
  if (tracked_bucket_ms !== null && tracked_bucket_ms > expected_ms) {
    throw new RangeError('expected bucket must not precede tracker bucket');
  }

  const same_bucket = tracked_bucket_ms === expected_ms;
  if (same_bucket && (current.status === 'succeeded' || current.status === 'terminal_error')) {
    throw new RangeError('the current bucket is already terminal');
  }
  if (same_bucket && current.status === 'retry_wait') {
    const retry_due_ms = timestamp_ms(current.retry_due_at);
    if (attempted_ms < retry_due_ms) throw new RangeError('retry attempted before retry_due_at');
  }

  const attempt_count = same_bucket ? current.attempt_count + 1 : 1;
  if (attempt_count > NIGHTWATCH_READ_MODEL_MAX_ATTEMPTS) {
    throw new RangeError('maximum attempts reached for the current bucket');
  }

  const result = {
    bucket_at: iso(expected_ms),
    attempt_count,
    status: 'terminal_error',
    retry_due_at: null,
    last_success_bucket_at: current.last_success_bucket_at,
  };

  if (outcome === 'success') {
    result.status = 'succeeded';
    result.last_success_bucket_at = iso(expected_ms);
    return result;
  }

  if (outcome === 'read_model_unavailable') {
    const retry_ms = Number(retry_after_ms);
    if (
      attempt_count < NIGHTWATCH_READ_MODEL_MAX_ATTEMPTS
      && retry_after_ms !== null
      && retry_after_ms !== undefined
      && retry_after_ms !== ''
      && Number.isFinite(retry_ms)
      && retry_ms >= 0
    ) {
      result.status = 'retry_wait';
      result.retry_due_at = iso(attempted_ms + retry_ms);
    }
    return result;
  }

  if (outcome === 'service_disabled' || outcome === 'error') return result;
  throw new TypeError('outcome must be success, read_model_unavailable, service_disabled, or error');
}
