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

export function previousCompletedTradingDate(sessionDateEt, closedDatesEt = []) {
  const session = validDateKey(sessionDateEt);
  if (!session) throw new Error('sessionDateEt must be YYYY-MM-DD.');
  const closed = new Set((closedDatesEt || []).map(validDateKey).filter(Boolean));
  let cursor = new Date(`${session}T00:00:00.000Z`);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    cursor = new Date(cursor.getTime() - 86_400_000);
    const dateKey = cursor.toISOString().slice(0, 10);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !closed.has(dateKey)) return dateKey;
  }
  throw new Error('Unable to resolve previous completed trading date.');
}

export function rankTradingDateForPolicy({
  session_date_et,
  closed_dates_et = [],
  require_previous_completed_nyse_trading_date = false,
} = {}) {
  const session = validDateKey(session_date_et);
  if (!session) throw new Error('session_date_et must be YYYY-MM-DD.');
  return require_previous_completed_nyse_trading_date
    ? previousCompletedTradingDate(session, closed_dates_et)
    : session;
}

export function normalizeOptionUnderlyingRank(response) {
  const source = response?.s2c || response?.data || response || {};
  const tradingDate = validDateKey(source.tradingDate ?? source.trading_date);
  const rows = Array.isArray(source.rankList) ? source.rankList : (Array.isArray(source.rows) ? source.rows : []);
  return {
    trading_date: tradingDate,
    trading_timestamp: finiteNumber(source.tradingTimestamp ?? source.trading_timestamp),
    all_count: finiteNumber(source.allCount ?? source.all_count),
    rows: rows.map((row, index) => ({
      rank: index + 1,
      ticker: normalizedTicker(row?.owner?.code ?? row?.ticker),
      market: finiteNumber(row?.owner?.market ?? row?.market),
      name: String(row?.name || '').trim() || null,
      total_volume: finiteNumber(row?.totalVolume ?? row?.total_volume),
      total_open_interest: finiteNumber(row?.totalOpenInterest ?? row?.total_open_interest),
      put_call_volume_ratio_pct: finiteNumber(row?.volumeRatio ?? row?.volume_ratio),
      put_call_open_interest_ratio_pct: finiteNumber(row?.openInterestRatio ?? row?.open_interest_ratio),
      iv_pct: finiteNumber(row?.iv),
      iv_rank_pct: finiteNumber(row?.ivRank ?? row?.iv_rank),
      iv_percentile_pct: finiteNumber(row?.ivPercentile ?? row?.iv_percentile),
      underlying_price_usd: finiteNumber(row?.price),
      change_rate_pct: finiteNumber(row?.changeRate ?? row?.change_rate),
      market_cap_usd: finiteNumber(row?.marketCap ?? row?.market_cap),
    })).filter((row) => row.ticker),
  };
}

export function nightwatchWorkingSetTickers(discoverResponse, workingSet = 'dealer-heatmap') {
  const source = discoverResponse?.data || discoverResponse || {};
  const rows = source?.working_sets?.[workingSet]?.tickers;
  if (!Array.isArray(rows)) return new Set();
  return new Set(rows.map(normalizedTicker).filter(Boolean));
}

export function buildTop100NightwatchCandidates({
  rank_response,
  discover_response,
  expected_trading_date,
  rank_count = 100,
  reserved_underlyings = ['SPX'],
  working_set = 'dealer-heatmap',
} = {}) {
  const rank = normalizeOptionUnderlyingRank(rank_response);
  const expectedDate = validDateKey(expected_trading_date);
  const coverage = nightwatchWorkingSetTickers(discover_response, working_set);
  const reserved = new Set((reserved_underlyings || []).map(normalizedTicker).filter(Boolean));
  const reasons = [];
  if (!expectedDate) reasons.push('expected_rank_trading_date_invalid');
  if (!rank.trading_date) reasons.push('rank_trading_date_missing');
  if (expectedDate && rank.trading_date && rank.trading_date !== expectedDate) {
    reasons.push(`rank_trading_date_mismatch:${rank.trading_date}`);
  }
  if (coverage.size === 0) reasons.push('nightwatch_working_set_missing');
  if (rank.rows.length === 0) reasons.push('top100_rank_rows_missing');

  const limit = Math.min(200, Math.max(1, Number(rank_count) || 100));
  const candidates = rank.rows.slice(0, limit).map((row) => ({
    ...row,
    nightwatch_supported: coverage.has(row.ticker),
    reserved_for_other_business_line: reserved.has(row.ticker),
  })).filter((row) => row.nightwatch_supported && !row.reserved_for_other_business_line);

  return {
    passed: reasons.length === 0,
    reasons,
    expected_trading_date: expectedDate,
    rank_trading_date: rank.trading_date,
    rank_row_count: rank.rows.length,
    nightwatch_working_set: working_set,
    nightwatch_working_set_count: coverage.size,
    candidates,
  };
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
