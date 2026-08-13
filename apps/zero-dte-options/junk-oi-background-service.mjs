import {
  build_junk_oi_structure_background,
} from './junk-oi-structure-background.mjs';

const DAY_MS = 86_400_000;

function date_key(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
    ? text
    : null;
}

function shifted_date_key(value, offset_days) {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed + offset_days * DAY_MS).toISOString().slice(0, 10);
}

function is_weekday(value) {
  const day = new Date(`${value}T12:00:00.000Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function finite_number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitized_error(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/sk_(?:live|test)_[A-Za-z0-9_-]+/g, '[redacted_api_key]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .slice(0, 1_000);
}

export function junk_oi_expected_dual_dates(session_date_et, market_calendar = {}) {
  const oi_effective_date = date_key(session_date_et);
  if (!oi_effective_date) throw new TypeError('session_date_et must be YYYY-MM-DD');
  const closed_dates = new Set(
    Array.isArray(market_calendar.closed_dates_et)
      ? market_calendar.closed_dates_et.map(String)
      : [],
  );
  if (!is_weekday(oi_effective_date) || closed_dates.has(oi_effective_date)) {
    throw new Error('OI effective date must be an open US options session');
  }
  let activity_trade_date = shifted_date_key(oi_effective_date, -1);
  for (let attempts = 0; attempts < 10; attempts += 1) {
    if (is_weekday(activity_trade_date) && !closed_dates.has(activity_trade_date)) {
      return { activity_trade_date, oi_effective_date };
    }
    activity_trade_date = shifted_date_key(activity_trade_date, -1);
  }
  throw new Error('Unable to resolve the previous US options trading date');
}

function ranked_rows(rows, limit) {
  const absolute_or_missing = (value) => {
    const parsed = finite_number(value);
    return parsed === null ? -1 : Math.abs(parsed);
  };
  return [...(Array.isArray(rows) ? rows : [])]
    .sort((left, right) => (
      absolute_or_missing(right?.oi_diff) - absolute_or_missing(left?.oi_diff)
      || (finite_number(right?.premium_usd) ?? -1) - (finite_number(left?.premium_usd) ?? -1)
      || String(left?.contract || `${left?.strike_usd}|${left?.right}`)
        .localeCompare(String(right?.contract || `${right?.strike_usd}|${right?.right}`))
    ))
    .slice(0, limit);
}

function compact_history(history) {
  if (!history || typeof history !== 'object' || Array.isArray(history)) return null;
  return {
    observation_count: finite_number(history.observation_count),
    oi_up_streak: finite_number(history.oi_up_streak),
    premium_up_streak: finite_number(history.premium_up_streak),
    volume_up_streak: finite_number(history.volume_up_streak),
    triple_up_streak: finite_number(history.triple_up_streak),
    windows: history.windows || {},
    insufficient_history: Array.isArray(history.insufficient_history)
      ? history.insufficient_history
      : [],
  };
}

function compact_contract(row) {
  return {
    contract: row.contract || null,
    root: row.root || null,
    expiration: row.expiration || null,
    right: row.right || null,
    strike_usd: finite_number(row.strike_usd),
    oi: finite_number(row.oi),
    prev_oi: finite_number(row.prev_oi),
    oi_diff: finite_number(row.oi_diff),
    volume: finite_number(row.volume),
    trades: finite_number(row.trades),
    premium_usd: finite_number(row.premium_usd),
    premium_source: row.premium_source || null,
    history: compact_history(row.history),
  };
}

function compact_strike(row) {
  return {
    strike_usd: finite_number(row.strike_usd),
    right: row.right || null,
    expirations: Array.isArray(row.expirations) ? row.expirations : [],
    contract_count: finite_number(row.contract_count),
    oi: finite_number(row.oi),
    prev_oi: finite_number(row.prev_oi),
    oi_diff: finite_number(row.oi_diff),
    volume: finite_number(row.volume),
    trades: finite_number(row.trades),
    premium_usd: finite_number(row.premium_usd),
    incomplete_fields: Array.isArray(row.incomplete_fields) ? row.incomplete_fields : [],
    history: compact_history(row.history),
  };
}

export function compact_junk_oi_structure_background(background, { top_n = 10 } = {}) {
  if (!background || typeof background !== 'object' || Array.isArray(background)) return null;
  const limit = Math.max(1, Math.min(50, Math.trunc(finite_number(top_n) ?? 10)));
  return {
    kind: background.kind || 'junk_oi_structure_background',
    version: background.version || 1,
    ticker: background.ticker || 'SPX',
    context_only: true,
    can_trigger_trade: false,
    can_veto_candidate: false,
    intraday_directional_signal: false,
    settlement_lagged: true,
    usable: background.usable === true,
    state: background.state || 'unavailable',
    activity_trade_date: background.activity_trade_date || null,
    oi_effective_date: background.oi_effective_date || null,
    source_as_of: background.source_as_of || null,
    captured_at: background.captured_at || null,
    options_volume_source_as_of: background.options_volume_source_as_of || null,
    options_volume: background.options_volume || null,
    score: background.score || null,
    reason_codes: Array.isArray(background.reason_codes) ? background.reason_codes : [],
    optional_context_reason_codes: Array.isArray(background.optional_context_reason_codes)
      ? background.optional_context_reason_codes
      : [],
    optional_context_errors: Array.isArray(background.optional_context_errors)
      ? background.optional_context_errors
      : [],
    evidence: background.evidence || null,
    top_contracts: ranked_rows(background.contracts, limit).map(compact_contract),
    top_strikes: ranked_rows(background.strikes, limit).map(compact_strike),
  };
}

export async function refresh_junk_oi_structure_background({
  nightwatch,
  store,
  session_date_et,
  market_calendar = {},
  policy = {},
  captured_at = new Date(),
} = {}) {
  if (!nightwatch || typeof nightwatch.get_options_oi_change !== 'function') {
    throw new TypeError('nightwatch must expose get_options_oi_change()');
  }
  if (!store || typeof store.load_history !== 'function' || typeof store.ingest_snapshot !== 'function') {
    throw new TypeError('store must expose load_history() and ingest_snapshot()');
  }
  const { activity_trade_date, oi_effective_date } = junk_oi_expected_dual_dates(
    session_date_et,
    market_calendar,
  );
  const ticker = String(policy.ticker || 'SPX').trim().toUpperCase();
  if (ticker !== 'SPX') throw new Error('JUNKMAN OI structure background is locked to SPX');
  const history = await store.load_history({
    ticker,
    limit_days: Math.max(10, Math.min(60, Math.trunc(finite_number(policy.max_history_days) ?? 60))),
  });

  const oi_change_response = await nightwatch.get_options_oi_change(ticker);
  let options_volume_response = null;
  const optional_context_errors = [];
  if (policy.options_volume_enabled !== false
    && typeof nightwatch.get_options_options_volume === 'function') {
    try {
      options_volume_response = await nightwatch.get_options_options_volume(ticker);
    } catch (error) {
      if ((finite_number(error?.retry_after_ms) ?? 0) > 0 || Number(error?.status) === 429) {
        throw error;
      }
      optional_context_errors.push(`options_volume_optional_unavailable:${sanitized_error(error)}`);
    }
  }

  const background = build_junk_oi_structure_background({
    oi_change_response,
    options_volume_response,
    expected_activity_trade_date: activity_trade_date,
    expected_oi_effective_date: oi_effective_date,
    history_snapshots: history,
    captured_at,
    max_source_age_ms: Math.max(60_000, finite_number(policy.max_source_age_ms) ?? 36 * 60 * 60 * 1_000),
    rolling_windows: Array.isArray(policy.rolling_windows) ? policy.rolling_windows : [3, 5, 10],
  });
  const enriched = {
    ...background,
    optional_context_errors,
  };
  let ingestion = null;
  if (background.usable && background.history_snapshot) {
    ingestion = await store.ingest_snapshot(enriched, {
      raw_payloads: {
        oi_change: oi_change_response,
        options_volume: options_volume_response,
      },
      captured_at: background.captured_at,
    });
  }
  return {
    background: enriched,
    compact: compact_junk_oi_structure_background(enriched, {
      top_n: finite_number(policy.top_rows_in_decision) ?? 10,
    }),
    ingestion,
  };
}
