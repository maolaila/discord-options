import registry from '../../config/trade-day-validity.json' with { type: 'json' };

export const TRADE_DAY_EXCLUSIONS = Object.freeze(registry.excluded_days);
const etDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function record_trading_date_et(row = {}) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(row.trading_date_et || '')) return row.trading_date_et;
  const at = row.entry_filled_at || row.entry_submitted_at || row.experiment_ledger?.created_at
    || row.event_at || row.planned_at || row.generated_at;
  if (at && Number.isFinite(Date.parse(at))) return etDate.format(new Date(at));
  return row.session_date_et || row.expiration || null;
}

export function excluded_trade_days(businessLine = 'zero-dte-options', exclusions = TRADE_DAY_EXCLUSIONS) {
  return exclusions.filter(day => day.business_lines.includes(businessLine));
}

export function trade_day_exclusion(row, businessLine = 'zero-dte-options', exclusions = TRADE_DAY_EXCLUSIONS) {
  const date = record_trading_date_et(row);
  return excluded_trade_days(row?.business_line || businessLine, exclusions).find(day => day.date_et === date) || null;
}

// Exclude the whole cohort, including fills recorded later than its entry day.
// Preserve the caller's original array and objects as the immutable audit input.
export function partition_performance_events(events, businessLine = 'zero-dte-options', exclusions = TRADE_DAY_EXCLUSIONS) {
  const invalidPlans = new Set();
  const invalidCohorts = new Set();
  for (const row of events) {
    if (!trade_day_exclusion(row, businessLine, exclusions)) continue;
    if (row.plan_id) invalidPlans.add(row.plan_id);
    if (row.cohort_id) invalidCohorts.add(row.cohort_id);
  }
  const included = [], excluded = [];
  for (const row of events) {
    const invalid = trade_day_exclusion(row, businessLine, exclusions)
      || invalidPlans.has(row.plan_id) || invalidCohorts.has(row.cohort_id);
    (invalid ? excluded : included).push(row);
  }
  return { included, excluded, days: excluded_trade_days(businessLine, exclusions) };
}
