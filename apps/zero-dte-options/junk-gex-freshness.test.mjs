import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assess_junk_gex_freshness,
  JUNK_GEX_FUTURE_TOLERANCE_MS,
  JUNK_GEX_MAX_AGE_MS,
  NIGHTWATCH_FIXED_SAMPLE_INTERVAL_MS,
} from './junk-gex-freshness.mjs';

const observed_at = '2026-08-13T14:30:30.000Z';

function response({
  source_age_ms = 1_000,
  meta_age_ms = 1_000,
  session_date_et = '2026-08-13',
  state = 'fresh',
  cache_hit = false,
} = {}) {
  return {
    data: {
      ticker: 'SPX',
      snapshot_at: new Date(Date.parse(observed_at) - source_age_ms).toISOString(),
      session_date_et,
      state,
    },
    _meta: {
      data_freshness_seconds: meta_age_ms / 1_000,
      cache_hit,
    },
  };
}

test('GEX limits match the documented five-minute fixed-sample timestamps', () => {
  assert.equal(NIGHTWATCH_FIXED_SAMPLE_INTERVAL_MS, 300_000);
  assert.equal(JUNK_GEX_MAX_AGE_MS, 600_000);
  assert.equal(JUNK_GEX_FUTURE_TOLERANCE_MS, 5_000);
});

test('payload snapshot_at accepts the latest completed sample with an inclusive ten-minute boundary', () => {
  for (const [source_age_ms, readiness] of [
    [300_000, 'ready'],
    [599_999, 'ready'],
    [600_000, 'ready'],
    [600_001, 'not_ready'],
  ]) {
    const result = assess_junk_gex_freshness({
      response: response({ source_age_ms, meta_age_ms: 1_000 }),
      observed_at,
    });
    assert.equal(result.source_age_ms, source_age_ms);
    assert.equal(result.readiness, readiness);
    assert.equal(result.reason_codes.includes('source_age_exceeded'), source_age_ms > 600_000);
  }
});

test('provider meta freshness independently uses the same inclusive ten-minute boundary', () => {
  for (const [meta_age_ms, readiness] of [
    [300_000, 'ready'],
    [599_999, 'ready'],
    [600_000, 'ready'],
    [600_001, 'not_ready'],
  ]) {
    const result = assess_junk_gex_freshness({
      response: response({ source_age_ms: 1_000, meta_age_ms }),
      observed_at,
    });
    assert.equal(result.meta_age_ms, meta_age_ms);
    assert.equal(result.readiness, readiness);
    assert.equal(result.reason_codes.includes('meta_age_exceeded'), meta_age_ms > 600_000);
  }
});

test('effective age takes the worse of payload and meta and meta conflict fails closed', () => {
  const result = assess_junk_gex_freshness({
    response: response({ source_age_ms: 5_000, meta_age_ms: 600_001, cache_hit: true }),
    observed_at,
  });
  assert.equal(result.source_age_ms, 5_000);
  assert.equal(result.meta_age_ms, 600_001);
  assert.equal(result.effective_age_ms, 600_001);
  assert.equal(result.cache_hit, true);
  assert.equal(result.readiness, 'not_ready');
  assert.deepEqual(result.reason_codes, ['meta_age_exceeded']);
});

test('freshness is fail-closed when payload state or required provider meta is absent', () => {
  const bad = response();
  delete bad.data.state;
  delete bad._meta.data_freshness_seconds;
  const result = assess_junk_gex_freshness({ response: bad, observed_at });
  assert.equal(result.meta_age_ms, null);
  assert.equal(result.effective_age_ms, null);
  assert.equal(result.readiness, 'not_ready');
  assert.deepEqual(result.reason_codes, [
    'provider_state_not_fresh',
    'missing_or_invalid_meta_freshness',
  ]);
});

test('timestamps over five seconds in the future fail while the exact boundary remains valid', () => {
  const boundary = assess_junk_gex_freshness({
    response: response({ source_age_ms: -5_000, meta_age_ms: -5_000 }),
    observed_at,
  });
  assert.equal(boundary.readiness, 'ready');

  const future = assess_junk_gex_freshness({
    response: response({ source_age_ms: -5_001, meta_age_ms: -5_001 }),
    observed_at,
  });
  assert.equal(future.readiness, 'not_ready');
  assert.deepEqual(future.reason_codes, [
    'source_snapshot_future',
    'meta_freshness_future',
  ]);
});

test('a fresh-looking snapshot from another ET session is not ready', () => {
  const result = assess_junk_gex_freshness({
    response: response({ session_date_et: '2026-08-12' }),
    observed_at,
  });
  assert.equal(result.current_session_date_et, '2026-08-13');
  assert.equal(result.readiness, 'not_ready');
  assert.deepEqual(result.reason_codes, ['cross_session_snapshot']);
});

test('repeated snapshots retain the advance time and increment the consecutive count', () => {
  const first = assess_junk_gex_freshness({ response: response(), observed_at });
  const second_observed_at = '2026-08-13T14:30:31.000Z';
  const second_response = response();
  second_response._meta.data_freshness_seconds = 2;
  const second = assess_junk_gex_freshness({
    response: second_response,
    observed_at: second_observed_at,
    previous_observation: first,
  });
  assert.equal(first.consecutive_same_snapshot_count, 1);
  assert.equal(first.last_advanced_at, observed_at);
  assert.equal(first.source_stalled, false);
  assert.equal(second.consecutive_same_snapshot_count, 2);
  assert.equal(second.last_advanced_at, observed_at);
  assert.equal(second.source_stalled, true);
  assert.equal(second.readiness, 'ready');
});

test('an advancing snapshot resets the repeat count and records the observation time', () => {
  const first = assess_junk_gex_freshness({ response: response(), observed_at });
  const repeated = assess_junk_gex_freshness({
    response: response(),
    observed_at: '2026-08-13T14:30:31.000Z',
    previous_observation: first,
  });
  const advanced_at = '2026-08-13T14:30:32.000Z';
  const advanced_response = response({ source_age_ms: -1_000, meta_age_ms: 1_000 });
  const advanced = assess_junk_gex_freshness({
    response: advanced_response,
    observed_at: advanced_at,
    previous_observation: repeated,
  });
  assert.equal(advanced.consecutive_same_snapshot_count, 1);
  assert.equal(advanced.last_advanced_at, advanced_at);
  assert.equal(advanced.source_stalled, false);
  assert.equal(advanced.readiness, 'ready');
});

test('a source timestamp regression fails closed and does not claim an advance', () => {
  const first = assess_junk_gex_freshness({ response: response(), observed_at });
  const regressed_response = response({ source_age_ms: 2_000, meta_age_ms: 2_000 });
  const regressed = assess_junk_gex_freshness({
    response: regressed_response,
    observed_at: '2026-08-13T14:30:31.000Z',
    previous_observation: first,
  });
  assert.equal(regressed.last_advanced_at, observed_at);
  assert.equal(regressed.readiness, 'not_ready');
  assert.ok(regressed.reason_codes.includes('source_snapshot_regressed'));
});
