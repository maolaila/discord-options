import assert from 'node:assert/strict';
import test from 'node:test';
import {
  create_fixed_sample_tracker,
  expected_completed_bucket_at,
  fixed_sample_bucket_matches,
  fixed_sample_request_due,
  NIGHTWATCH_FIXED_SAMPLE_INTERVAL_MS,
  NIGHTWATCH_READ_MODEL_MAX_ATTEMPTS,
  record_fixed_sample_outcome,
} from './nightwatch-fixed-sample-scheduler.mjs';

const at = (value) => `2026-08-13T${value}.000Z`;

test('the expected completed bucket is epoch-aligned and one interval behind the boundary', () => {
  assert.equal(NIGHTWATCH_FIXED_SAMPLE_INTERVAL_MS, 300_000);
  assert.equal(NIGHTWATCH_READ_MODEL_MAX_ATTEMPTS, 3);
  assert.equal(expected_completed_bucket_at(at('13:35:00')), at('13:30:00'));
  assert.equal(expected_completed_bucket_at(at('13:39:59')), at('13:30:00'));
  assert.equal(expected_completed_bucket_at(at('13:40:00')), at('13:35:00'));
});

test('a response must identify the exact expected bucket rather than a merely young-enough bucket', () => {
  assert.equal(fixed_sample_bucket_matches(at('13:30:00'), at('13:30:00')), true);
  assert.equal(fixed_sample_bucket_matches(at('13:25:00'), at('13:30:00')), false);
  assert.equal(fixed_sample_bucket_matches(at('13:35:00'), at('13:30:00')), false);
  assert.equal(fixed_sample_bucket_matches('invalid', at('13:30:00')), false);
});

test('the session gate prevents a request before the first 09:30 bucket completes', () => {
  const tracker = create_fixed_sample_tracker();
  assert.deepEqual(fixed_sample_request_due({
    now: at('13:34:59'),
    tracker,
    session_open_minutes: 570,
    ny_minutes: 574,
  }), {
    due: false,
    reason: 'before_first_completed_bucket',
    expected_bucket_at: at('13:25:00'),
  });
  assert.equal(fixed_sample_request_due({
    now: at('13:35:00'),
    tracker,
    session_open_minutes: 570,
    ny_minutes: 575,
  }).due, true);
});

test('normal success permits exactly one request per completed bucket', () => {
  const bucket = at('13:30:00');
  const initial = create_fixed_sample_tracker();
  const first = fixed_sample_request_due({ now: at('13:35:01'), tracker: initial });
  assert.deepEqual(first, {
    due: true,
    reason: 'new_completed_bucket',
    expected_bucket_at: bucket,
  });

  const succeeded = record_fixed_sample_outcome({
    tracker: initial,
    expected_bucket_at: first.expected_bucket_at,
    attempted_at: at('13:35:01'),
    outcome: 'success',
  });
  assert.equal(succeeded.attempt_count, 1);
  assert.equal(succeeded.last_success_bucket_at, bucket);
  assert.deepEqual(fixed_sample_request_due({ now: at('13:39:59'), tracker: succeeded }), {
    due: false,
    reason: 'already_succeeded',
    expected_bucket_at: bucket,
  });
  assert.deepEqual(fixed_sample_request_due({ now: at('13:40:00'), tracker: succeeded }), {
    due: true,
    reason: 'new_completed_bucket',
    expected_bucket_at: at('13:35:00'),
  });
});

test('READ_MODEL_UNAVAILABLE obeys retry_after and stops at three total attempts', () => {
  const bucket = at('13:30:00');
  let tracker = create_fixed_sample_tracker();

  tracker = record_fixed_sample_outcome({
    tracker,
    expected_bucket_at: bucket,
    attempted_at: at('13:35:01'),
    outcome: 'read_model_unavailable',
    retry_after_ms: 20_000,
  });
  assert.equal(tracker.attempt_count, 1);
  assert.deepEqual(fixed_sample_request_due({ now: at('13:35:20'), tracker }), {
    due: false,
    reason: 'read_model_retry_wait',
    expected_bucket_at: bucket,
  });
  assert.deepEqual(fixed_sample_request_due({ now: at('13:35:21'), tracker }), {
    due: true,
    reason: 'read_model_retry_due',
    expected_bucket_at: bucket,
  });

  tracker = record_fixed_sample_outcome({
    tracker,
    expected_bucket_at: bucket,
    attempted_at: at('13:35:21'),
    outcome: 'read_model_unavailable',
    retry_after_ms: 10_000,
  });
  tracker = record_fixed_sample_outcome({
    tracker,
    expected_bucket_at: bucket,
    attempted_at: at('13:35:31'),
    outcome: 'read_model_unavailable',
    retry_after_ms: 1,
  });
  assert.equal(tracker.attempt_count, 3);
  assert.equal(tracker.status, 'terminal_error');
  assert.deepEqual(fixed_sample_request_due({ now: at('13:39:59'), tracker }), {
    due: false,
    reason: 'waiting_for_next_bucket',
    expected_bucket_at: bucket,
  });

  const next = fixed_sample_request_due({ now: at('13:40:00'), tracker });
  assert.equal(next.due, true);
  assert.equal(next.reason, 'new_completed_bucket');
  const next_tracker = record_fixed_sample_outcome({
    tracker,
    expected_bucket_at: next.expected_bucket_at,
    attempted_at: at('13:40:00'),
    outcome: 'success',
  });
  assert.equal(next_tracker.attempt_count, 1);
});

test('missing retry_after fails closed until the next bucket', () => {
  const tracker = record_fixed_sample_outcome({
    tracker: create_fixed_sample_tracker(),
    expected_bucket_at: at('13:30:00'),
    attempted_at: at('13:35:01'),
    outcome: 'read_model_unavailable',
  });
  assert.equal(tracker.status, 'terminal_error');
  assert.equal(fixed_sample_request_due({ now: at('13:36:00'), tracker }).due, false);
});

test('SERVICE_DISABLED and other errors wait for the next completed bucket', () => {
  for (const outcome of ['service_disabled', 'error']) {
    const tracker = record_fixed_sample_outcome({
      tracker: create_fixed_sample_tracker(),
      expected_bucket_at: at('13:30:00'),
      attempted_at: at('13:35:01'),
      outcome,
    });
    assert.deepEqual(fixed_sample_request_due({ now: at('13:39:59'), tracker }), {
      due: false,
      reason: 'waiting_for_next_bucket',
      expected_bucket_at: at('13:30:00'),
    });
    assert.equal(fixed_sample_request_due({ now: at('13:40:00'), tracker }).due, true);
  }
});

test('GEX and Heatmap trackers remain independent', () => {
  const gex = record_fixed_sample_outcome({
    tracker: create_fixed_sample_tracker(),
    expected_bucket_at: at('13:30:00'),
    attempted_at: at('13:35:01'),
    outcome: 'success',
  });
  const heatmap = create_fixed_sample_tracker();
  assert.equal(fixed_sample_request_due({ now: at('13:36:00'), tracker: gex }).due, false);
  assert.deepEqual(fixed_sample_request_due({ now: at('13:36:00'), tracker: heatmap }), {
    due: true,
    reason: 'new_completed_bucket',
    expected_bucket_at: at('13:30:00'),
  });
});

test('invalid state and clock regression fail closed', () => {
  assert.deepEqual(fixed_sample_request_due({
    now: at('13:36:00'),
    tracker: { bucket_at: 'bad timestamp' },
  }), {
    due: false,
    reason: 'invalid_tracker',
    expected_bucket_at: at('13:30:00'),
  });

  const future = record_fixed_sample_outcome({
    tracker: create_fixed_sample_tracker(),
    expected_bucket_at: at('13:35:00'),
    attempted_at: at('13:40:00'),
    outcome: 'success',
  });
  assert.deepEqual(fixed_sample_request_due({ now: at('13:36:00'), tracker: future }), {
    due: false,
    reason: 'clock_regressed',
    expected_bucket_at: at('13:30:00'),
  });
});

test('incomplete or invalid session context fails closed', () => {
  const tracker = create_fixed_sample_tracker();
  assert.equal(fixed_sample_request_due({
    now: at('13:35:00'),
    tracker,
    session_open_minutes: 570,
  }).reason, 'invalid_session_context');
  assert.equal(fixed_sample_request_due({
    now: at('13:35:00'),
    tracker,
    session_open_minutes: -1,
    ny_minutes: 575,
  }).reason, 'invalid_session_context');
});
