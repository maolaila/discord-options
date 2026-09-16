// Observation only. This module cannot change a signal, position or exit rule.
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MINUTE = 60_000;
const specs = Object.freeze({
  volatility: { method: 'get_volatility_stats', interval: 30 * MINUTE },
  term_structure: { method: 'get_volatility_term_structure', interval: 30 * MINUTE },
  economic_calendar: { method: 'get_economic_calendar', interval: 6 * 60 * MINUTE },
});
const finite = (value) => value === null || value === undefined || value === ''
  ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
export const research_date_et = (now) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(now));

export function normalize_research_source(kind, response, now = new Date()) {
  const data = response?.data;
  const meta = response?._meta || {};
  const result = {
    observed_at: now.toISOString(), as_of: data?.as_of || null,
    data_date: data?.date || null, provider_age_seconds: finite(meta.data_freshness_seconds),
    request_id: meta.request_id || null, truncated: meta.truncated === true,
    state: 'unavailable', usable: false,
    cadence: kind === 'economic_calendar' ? 'forward_calendar' : 'daily_background',
  };
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ...result, state: meta.status === 'materializing' ? 'materializing' : 'schema_unknown' };
  }
  if (kind !== 'economic_calendar' && data.ticker !== 'SPX') {
    return { ...result, state: 'ticker_mismatch' };
  }
  if (kind === 'volatility') {
    result.values = {
      // Preserve provider units verbatim: iv_pct currently arrives as a fraction.
      iv_pct_provider: finite(data.iv_pct), iv_rank: finite(data.iv_rank),
      rv_pct_provider: finite(data.rv_pct), unit: 'provider_native_not_rescaled',
    };
    result.usable = Object.values(result.values).some((v) => typeof v === 'number');
  } else if (kind === 'term_structure') {
    result.nodes = (Array.isArray(data.nodes) ? data.nodes : [])
      .filter((node) => /^\d{4}-\d{2}-\d{2}$/.test(node.expiry || '')
        && finite(node.dte) !== null && finite(node.implied_vol_pct) !== null)
      .map((node) => ({ expiration: node.expiry, dte: finite(node.dte),
        iv_pct_provider: finite(node.implied_vol_pct) }))
      .sort((a, b) => a.dte - b.dte).slice(0, 64);
    result.usable = result.nodes.length > 0;
    result.unit = 'provider_native_not_rescaled';
  } else if (kind === 'economic_calendar') {
    result.events = (Array.isArray(data.events) ? data.events : [])
      .filter((event) => typeof event.event === 'string'
        && Number.isFinite(Date.parse(event.scheduled_at)))
      .map((event) => ({ event: event.event.slice(0, 300), scheduled_at: event.scheduled_at,
        event_type: event.event_type || null }))
      .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at)).slice(0, 200);
    result.usable = Array.isArray(data.events);
    result.coverage = 'provider_listing_only_not_a_complete_risk_calendar';
  }
  result.state = result.usable ? 'available_background' : 'schema_unknown';
  return result;
}

export function research_context_snapshot(sources = {}, now = new Date(), extra = {}) {
  const today = research_date_et(now);
  const dated = Object.fromEntries(Object.entries(sources).map(([kind, source]) => {
    const age = (now.getTime() - Date.parse(source.observed_at)) / 1000;
    const fetched_recently = Number.isFinite(age) && age >= 0
      && age <= (specs[kind]?.interval || MINUTE) * 2 / 1000;
    const date_relation = !source.data_date ? 'unknown'
      : source.data_date === today ? 'same_session_date'
        : source.data_date < today ? 'prior_session_date' : 'future_date_rejected';
    return [kind, { ...source, fetched_recently, date_relation,
      usable: source.usable === true && fetched_recently && date_relation !== 'future_date_rejected',
      intraday_iv_usable: false }];
  }));
  const events = dated.economic_calendar?.usable ? dated.economic_calendar.events || [] : [];
  return {
    schema_version: 1, kind: 'junk_research_context', observation_only: true,
    affects_entry: false, affects_sizing: false, affects_exit: false,
    ticker: 'SPX', session_date_et: today, evaluated_at: now.toISOString(),
    sources: dated,
    events_today: events.filter((event) => research_date_et(event.scheduled_at) === today)
      .map((event) => ({ ...event, minutes_from_now: Math.round((Date.parse(event.scheduled_at) - now) / MINUTE) })),
    event_window_minutes: 30,
    near_event: dated.economic_calendar?.usable
      ? events.some((event) => Math.abs(Date.parse(event.scheduled_at) - now) <= 30 * MINUTE) : null,
    vex: { state: 'no_public_api', enabled: false }, ...extra,
  };
}

export function create_research_context_service({ client, latest_path, history_path,
  initial_sources = {}, now_ms = () => Date.now(), persist = null } = {}) {
  let sources = { ...initial_sources };
  let pending = null;
  let stopped = false;
  let io_error = null;
  let blocked_until = 0;
  const next_due = {};
  let last_started = -Infinity;
  const controller = new AbortController();
  const save = persist || (async (snapshot) => {
    await mkdir(path.dirname(latest_path), { recursive: true });
    const temp = `${latest_path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(snapshot, null, 2) + '\n');
    await rename(temp, latest_path);
    await appendFile(history_path, JSON.stringify(snapshot) + '\n');
  });
  function snapshot(now = new Date(now_ms())) {
    return research_context_snapshot(sources, now, {
      refresh_in_flight: pending !== null, io_error,
      blocked_until: blocked_until > now_ms() ? new Date(blocked_until).toISOString() : null,
    });
  }
  // Returns immediately. The trading loop NEVER awaits a research request.
  function kick({ enabled = true, provider_blocked = false } = {}) {
    const started = now_ms();
    if (stopped || !enabled || provider_blocked || pending || started < blocked_until
      || started - last_started < 1_100) return false;
    const kind = Object.keys(specs).find((key) => started >= (next_due[key] || 0));
    if (!kind) return false;
    const spec = specs[kind];
    last_started = started;
    next_due[kind] = started + spec.interval;
    pending = Promise.resolve().then(async () => {
      try {
        const options = { signal: controller.signal };
        const response = kind === 'economic_calendar'
          ? await client[spec.method](options) : await client[spec.method]('SPX', options);
        sources[kind] = normalize_research_source(kind, response, new Date(now_ms()));
        if (!sources[kind].usable) {
          next_due[kind] = now_ms() + Math.max(5 * MINUTE,
            (finite(response?._meta?.retry_after_seconds) || 0) * 1000);
        }
      } catch (error) {
        const retry = Math.max(5 * MINUTE, finite(error?.retry_after_ms) || 0);
        next_due[kind] = now_ms() + retry;
        if (error?.status === 429) blocked_until = next_due[kind];
        // Do not persist provider bodies, headers or exception messages.
        sources[kind] = { observed_at: new Date(now_ms()).toISOString(),
          state: 'request_failed', usable: false, status: finite(error?.status),
          error_code: /^[A-Z0-9_]+$/.test(error?.error_code || '') ? error.error_code : 'REQUEST_FAILED',
          retry_at: new Date(next_due[kind]).toISOString() };
      }
      try { await save({ ...snapshot(), refresh_in_flight: false }); io_error = null; }
      catch { io_error = 'research_write_failed'; }
    }).catch(() => { io_error = 'research_refresh_failed'; }).finally(() => { pending = null; });
    return true;
  }
  return { kick, snapshot, idle: () => pending || Promise.resolve(),
    stop: () => { stopped = true; controller.abort(); } };
}

export async function load_research_sources(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return parsed.kind === 'junk_research_context' ? parsed.sources || {} : {};
  } catch { return {}; }
}
