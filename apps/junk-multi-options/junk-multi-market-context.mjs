const FIVE_MINUTE_MS = 300_000;

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nyParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour === '24' ? 0 : values.hour), minute: Number(values.minute), second: Number(values.second),
  };
}

function nyLocalTimeToIso(value) {
  const match = String(value || '').trim().match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const desired = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0));
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actualParts = nyParts(new Date(guess));
    const actual = Date.UTC(actualParts.year, actualParts.month - 1, actualParts.day, actualParts.hour, actualParts.minute, actualParts.second);
    guess += desired - actual;
  }
  return new Date(guess).toISOString();
}

function barTimestamp(row) {
  const epochSeconds = finiteNumber(row?.timestamp);
  if (epochSeconds !== null && epochSeconds > 1_000_000_000) {
    return new Date(epochSeconds * 1_000).toISOString();
  }
  return nyLocalTimeToIso(row?.time ?? row?.timeKey);
}

export function normalizeClosedFiveMinuteBars(response, {
  session_date_et,
  now_ms = Date.now(),
} = {}) {
  const rows = response?.s2c?.klList || response?.data?.klList || response?.klList || [];
  const bars = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.isBlank === true) continue;
    const timestamp = barTimestamp(row);
    const timestampMs = Date.parse(String(timestamp || ''));
    const open = finiteNumber(row?.openPrice ?? row?.open);
    const high = finiteNumber(row?.highPrice ?? row?.high);
    const low = finiteNumber(row?.lowPrice ?? row?.low);
    const close = finiteNumber(row?.closePrice ?? row?.close);
    const volume = finiteNumber(row?.hpVolume ?? row?.volume);
    const turnover = finiteNumber(row?.turnover);
    if (![timestampMs, open, high, low, close, volume].every((value) => value !== null && Number.isFinite(value))) continue;
    if (timestampMs + FIVE_MINUTE_MS > Number(now_ms) + 1_000) continue;
    const parts = nyParts(new Date(timestampMs));
    const dateKey = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    const minuteOfDay = parts.hour * 60 + parts.minute;
    if (dateKey !== String(session_date_et || '').slice(0, 10)) continue;
    if (minuteOfDay < 570 || minuteOfDay >= 960) continue;
    bars.push({
      timestamp,
      open_usd: open,
      high_usd: high,
      low_usd: low,
      close_usd: close,
      volume,
      turnover_usd: turnover,
    });
  }
  bars.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  return bars;
}

export function sessionVwapUsd(bars) {
  let value = 0;
  let volume = 0;
  for (const bar of bars || []) {
    const barVolume = finiteNumber(bar?.volume);
    if (barVolume === null || barVolume <= 0) continue;
    const turnover = finiteNumber(bar?.turnover_usd);
    const typical = [bar?.high_usd, bar?.low_usd, bar?.close_usd]
      .map(finiteNumber).filter((item) => item !== null);
    const price = turnover !== null && turnover > 0
      ? turnover / barVolume
      : (typical.length === 3 ? typical.reduce((sum, item) => sum + item, 0) / 3 : null);
    if (price === null || price <= 0) continue;
    value += price * barVolume;
    volume += barVolume;
  }
  return volume > 0 ? Number((value / volume).toFixed(6)) : null;
}

export function buildMultiSymbolMarketContext(response, options = {}) {
  const bars = normalizeClosedFiveMinuteBars(response, options);
  const latest = bars.at(-1) || null;
  return {
    price_action_source: 'moomoo_own_symbol_history_5m',
    price_action_ready: bars.length > 0,
    bars_5m: bars,
    last_price_usd: latest?.close_usd ?? null,
    vwap_usd: sessionVwapUsd(bars),
    expected_bucket_at: latest?.timestamp ?? null,
    latest_closed_bar_at: latest?.timestamp ?? null,
  };
}
