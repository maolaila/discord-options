const FIVE_MINUTE_MS = 300_000;

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/^\./, '');
}

function validDateKey(value) {
  const text = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null;
}

export function nightwatchWorkingSetTickers(discoverResponse, workingSet = 'dealer-heatmap') {
  const source = discoverResponse?.data || discoverResponse || {};
  const rows = source?.working_sets?.[workingSet]?.tickers;
  if (!Array.isArray(rows)) return new Set();
  return new Set(rows.map(normalizedTicker).filter(Boolean));
}

export function inferOptionStrikeStep(contracts) {
  const strikes = [...new Set((contracts || [])
    .map((row) => finiteNumber(row?.strikePrice ?? row?.strike_usd))
    .filter((value) => value !== null && value > 0))].sort((left, right) => left - right);
  const gaps = [];
  for (let index = 1; index < strikes.length; index += 1) {
    const gap = Number((strikes[index] - strikes[index - 1]).toFixed(6));
    if (gap > 0) gaps.push(gap);
  }
  return gaps.length > 0 ? Math.min(...gaps) : null;
}

export function exactFixedSampleBucket(timestamp, expectedBucketAt, intervalMs = FIVE_MINUTE_MS) {
  const timestampMs = Date.parse(String(timestamp || ''));
  const expectedMs = Date.parse(String(expectedBucketAt || ''));
  if (!Number.isFinite(timestampMs) || !Number.isFinite(expectedMs)) return false;
  return Math.floor(timestampMs / intervalMs) === Math.floor(expectedMs / intervalMs);
}

export function validateNightwatchTickerEvidence({
  ticker,
  session_date_et,
  expected_bucket_at,
  gex_response,
  heatmap_response,
  now_ms = Date.now(),
  max_age_ms = 600_000,
  require_heatmap_snapshot = true,
} = {}) {
  const expectedTicker = normalizedTicker(ticker);
  const expectedSession = validDateKey(session_date_et);
  const gex = gex_response?.data || gex_response || {};
  const heatmap = heatmap_response?.data || heatmap_response || {};
  const reasons = [];
  const heatmapReasons = [];
  const gexTicker = normalizedTicker(gex.ticker);
  const heatmapTicker = normalizedTicker(heatmap.ticker || ticker);
  const gexAt = gex.snapshot_at || gex.sample_at || gex.timestamp;
  const heatmapAt = heatmap.generated_at || heatmap.snapshot_at || heatmap.sample_at;
  if (!expectedTicker) reasons.push('ticker_missing');
  if (gexTicker !== expectedTicker) reasons.push(`gex_ticker_mismatch:${gexTicker || 'missing'}`);
  if (heatmapTicker && heatmapTicker !== expectedTicker) heatmapReasons.push(`heatmap_ticker_mismatch:${heatmapTicker}`);
  if (validDateKey(gex.session_date_et) !== expectedSession) reasons.push('gex_session_date_mismatch');
  if (validDateKey(heatmap.session_date_et) !== expectedSession) heatmapReasons.push('heatmap_session_date_mismatch');
  if (String(gex.state || '').toLowerCase() !== 'fresh') reasons.push(`gex_state_not_fresh:${gex.state || 'missing'}`);
  if (String(heatmap.state || '').toLowerCase() !== 'fresh') heatmapReasons.push(`heatmap_state_not_fresh:${heatmap.state || 'missing'}`);
  for (const [label, value, target] of [['gex', gexAt, reasons], ['heatmap', heatmapAt, heatmapReasons]]) {
    const atMs = Date.parse(String(value || ''));
    if (!Number.isFinite(atMs)) target.push(`${label}_timestamp_invalid`);
    else if (Number(now_ms) - atMs > Number(max_age_ms)) target.push(`${label}_stale`);
    else if (atMs > Number(now_ms) + 5_000) target.push(`${label}_from_future`);
    if (!exactFixedSampleBucket(value, expected_bucket_at)) target.push(`${label}_fixed_sample_bucket_mismatch`);
  }
  if (require_heatmap_snapshot) reasons.push(...heatmapReasons);
  return {
    passed: reasons.length === 0,
    reasons: [...new Set(reasons)],
    advisory_reasons: require_heatmap_snapshot ? [] : [...new Set(heatmapReasons)],
  };
}
