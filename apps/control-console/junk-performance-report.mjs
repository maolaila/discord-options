import fs from 'node:fs';

const ET_TIME_ZONE = 'America/New_York';
const OPTION_MULTIPLIER = 100;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
}

function datePartsInEt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

export function trading_date_et(value) {
  const parts = datePartsInEt(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : null;
}

function etWallTimeToUtc(dateString, hour, minute = 0) {
  const [year, month, day] = dateString.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = datePartsInEt(new Date(guess));
    const shown = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    guess += target - shown;
  }
  return new Date(guess);
}

function isoDateFromUtcDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const [year, month, day] = dateString.split('-').map(Number);
  return isoDateFromUtcDate(new Date(Date.UTC(year, month - 1, day + days)));
}

function weekday(dateString) {
  return new Date(`${dateString}T12:00:00Z`).getUTCDay();
}

function nthWeekday(year, month, weekdayNumber, nth) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekdayNumber - first.getUTCDay() + 7) % 7;
  return isoDateFromUtcDate(new Date(Date.UTC(year, month - 1, 1 + offset + 7 * (nth - 1))));
}

function lastWeekday(year, month, weekdayNumber) {
  const last = new Date(Date.UTC(year, month, 0));
  const offset = (last.getUTCDay() - weekdayNumber + 7) % 7;
  return isoDateFromUtcDate(new Date(Date.UTC(year, month - 1, last.getUTCDate() - offset)));
}

function observedFixedHoliday(year, month, day) {
  const actual = isoDateFromUtcDate(new Date(Date.UTC(year, month - 1, day)));
  const dayOfWeek = weekday(actual);
  if (dayOfWeek === 6) return addDays(actual, -1);
  if (dayOfWeek === 0) return addDays(actual, 1);
  return actual;
}

// Gregorian Easter algorithm. NYSE closes on Good Friday.
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoDateFromUtcDate(new Date(Date.UTC(year, month - 1, day)));
}

function marketHolidays(year) {
  const holidays = new Set([
    observedFixedHoliday(year, 1, 1),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    addDays(easterSunday(year), -2),
    lastWeekday(year, 5, 1),
    observedFixedHoliday(year, 6, 19),
    observedFixedHoliday(year, 7, 4),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 11, 4, 4),
    observedFixedHoliday(year, 12, 25),
  ]);
  // A Saturday New Year's Day is observed in the prior calendar year.
  holidays.add(observedFixedHoliday(year + 1, 1, 1));
  return holidays;
}

function regularSessionHours(dateString) {
  const dayOfWeek = weekday(dateString);
  if (dayOfWeek === 0 || dayOfWeek === 6) return 0;
  const year = Number(dateString.slice(0, 4));
  if (marketHolidays(year).has(dateString)) return 0;
  return 6.5;
}

function sessionSecondsBetween(firstDate, lastDate) {
  if (!firstDate || !lastDate || firstDate > lastDate) return 0;
  let cursor = firstDate;
  let hours = 0;
  while (cursor <= lastDate) {
    hours += regularSessionHours(cursor);
    cursor = addDays(cursor, 1);
  }
  return hours * 3600;
}

export function read_ndjson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function lineDefinitions(policy) {
  return (policy?.exit_experiment?.lines || []).map((line) => ({
    line_id: line.line_id,
    label: line.label || line.line_id,
    control: line.control === true,
    observation_only: String(line.entry_profile || 'base_v3') !== 'base_v3',
    stop_loss_pct: number(line.catastrophic_stop_loss_pct ?? line.option_stop_loss_pct),
    take_profit_enabled: line.option_take_profit_enabled === true,
    take_profit_pct: line.option_take_profit_enabled === true ? number(line.option_take_profit_pct) : null,
    paper_equity_usd: number(line.paper_equity_usd, 10_000),
  }));
}

function blankMetrics(definition) {
  return {
    ...definition,
    trade_count: 0,
    win_count: 0,
    loss_count: 0,
    flat_count: 0,
    purchase_cost_usd: 0,
    sale_proceeds_usd: 0,
    gross_pnl_usd: 0,
    account_return_pct: 0,
    turnover_return_pct: null,
    average_entry_usd: null,
    average_entry_rate_pct: null,
    gross_profit_usd: 0,
    gross_loss_usd: 0,
    profit_factor: null,
    average_deployed_usd: 0,
    time_weighted_utilization_pct: 0,
    open_contract_qty: 0,
  };
}

function closeEventKey(row) {
  return [row.event_at, row.plan_id, row.cohort_id, row.line_id, row.code].join('|');
}

function closedTrades(events) {
  const seen = new Set();
  return events.filter((row) => {
    if (row?.event !== 'experiment_line_position_closed' || !row.line_id) return false;
    const key = closeEventKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return Number.isFinite(Number(row.entry_value))
      && Number.isFinite(Number(row.exit_value))
      && Number.isFinite(Number(row.realized_pnl_usd));
  }).map((row) => ({
    ...row,
    trading_date_et: trading_date_et(row.event_at),
    purchase_cost_usd: round(number(row.entry_value) * OPTION_MULTIPLIER),
    sale_proceeds_usd: round(number(row.exit_value) * OPTION_MULTIPLIER),
    gross_pnl_usd: round(number(row.realized_pnl_usd)),
  }));
}

function exposureIntervals(events, pricedCloseKeys) {
  const lots = new Map();
  const intervals = [];
  const sorted = events
    .filter((row) => row?.event === 'experiment_line_entry_allocated' || row?.event === 'experiment_line_exit_fill_progress')
    .filter((row) => row.line_id && row.plan_id && !Number.isNaN(new Date(row.event_at).getTime()))
    .filter((row) => pricedCloseKeys.has(`${row.plan_id}|${row.line_id}`))
    .sort((left, right) => new Date(left.event_at) - new Date(right.event_at));
  for (const row of sorted) {
    const key = `${row.plan_id}|${row.line_id}`;
    const at = new Date(row.event_at);
    if (row.event === 'experiment_line_entry_allocated') {
      const qty = Math.max(0, Math.floor(number(row.qty)));
      if (qty < 1) continue;
      lots.set(key, {
        line_id: row.line_id,
        qty,
        dollars_per_contract: number(row.entry_value) * OPTION_MULTIPLIER / qty,
        last_at: at,
        trading_date_et: trading_date_et(at),
      });
      continue;
    }
    const lot = lots.get(key);
    if (!lot || lot.qty < 1) continue;
    intervals.push({
      line_id: lot.line_id,
      trading_date_et: lot.trading_date_et,
      start: lot.last_at,
      end: at,
      deployed_usd: lot.qty * lot.dollars_per_contract,
    });
    lot.qty = Math.max(0, lot.qty - Math.max(0, Math.floor(number(row.qty))));
    lot.last_at = at;
  }
  const latestEventAt = events.reduce((latest, row) => {
    const at = new Date(row?.event_at);
    return !Number.isNaN(at.getTime()) && at > latest ? at : latest;
  }, new Date(0));
  for (const lot of lots.values()) {
    if (lot.qty < 1) continue;
    const close = etWallTimeToUtc(lot.trading_date_et, 16, 0);
    const end = latestEventAt > lot.last_at && latestEventAt < close ? latestEventAt : close;
    if (end > lot.last_at) intervals.push({
      line_id: lot.line_id,
      trading_date_et: lot.trading_date_et,
      start: lot.last_at,
      end,
      deployed_usd: lot.qty * lot.dollars_per_contract,
    });
  }
  return intervals;
}

function capitalSeconds(intervals, lineId, firstDate, lastDate) {
  return intervals
    .filter((interval) => interval.line_id === lineId)
    .filter((interval) => interval.trading_date_et >= firstDate && interval.trading_date_et <= lastDate)
    .reduce((total, interval) => total + Math.max(0, (interval.end - interval.start) / 1000) * interval.deployed_usd, 0);
}

function openQtyByLine(events, experimentSummary) {
  if (Array.isArray(experimentSummary?.lines)) {
    const summarized = new Map();
    for (const row of experimentSummary.lines) {
      const lineId = row?.experiment_line_id || row?.line_id;
      if (!lineId) continue;
      summarized.set(lineId, (summarized.get(lineId) || 0) + Math.max(0, Math.floor(number(row.open_contract_qty))));
    }
    return summarized;
  }
  const quantities = new Map();
  for (const row of events) {
    if (!row?.line_id || !row.plan_id) continue;
    const key = `${row.plan_id}|${row.line_id}`;
    if (row.event === 'experiment_line_entry_allocated') {
      quantities.set(key, Math.max(0, Math.floor(number(row.qty))));
    } else if (row.event === 'experiment_line_exit_fill_progress' && quantities.has(key)) {
      quantities.set(key, Math.max(0, quantities.get(key) - Math.max(0, Math.floor(number(row.qty)))));
    }
  }
  const byLine = new Map();
  for (const [key, qty] of quantities) {
    const lineId = key.slice(key.indexOf('|') + 1);
    byLine.set(lineId, (byLine.get(lineId) || 0) + qty);
  }
  return byLine;
}

function summarizePeriod(definitions, trades, intervals, firstDate, lastDate, openByLine) {
  const denominatorSeconds = sessionSecondsBetween(firstDate, lastDate);
  return definitions.map((definition) => {
    const result = blankMetrics(definition);
    const rows = trades.filter((trade) => trade.line_id === definition.line_id)
      .filter((trade) => trade.trading_date_et >= firstDate && trade.trading_date_et <= lastDate);
    for (const trade of rows) {
      result.trade_count += 1;
      result.purchase_cost_usd += trade.purchase_cost_usd;
      result.sale_proceeds_usd += trade.sale_proceeds_usd;
      result.gross_pnl_usd += trade.gross_pnl_usd;
      if (trade.gross_pnl_usd > 0.005) {
        result.win_count += 1;
        result.gross_profit_usd += trade.gross_pnl_usd;
      } else if (trade.gross_pnl_usd < -0.005) {
        result.loss_count += 1;
        result.gross_loss_usd += Math.abs(trade.gross_pnl_usd);
      } else result.flat_count += 1;
    }
    result.purchase_cost_usd = round(result.purchase_cost_usd);
    result.sale_proceeds_usd = round(result.sale_proceeds_usd);
    result.gross_pnl_usd = round(result.gross_pnl_usd);
    result.gross_profit_usd = round(result.gross_profit_usd);
    result.gross_loss_usd = round(result.gross_loss_usd);
    result.account_return_pct = round(result.gross_pnl_usd / definition.paper_equity_usd * 100);
    result.turnover_return_pct = result.purchase_cost_usd > 0
      ? round(result.gross_pnl_usd / result.purchase_cost_usd * 100)
      : null;
    result.average_entry_usd = result.trade_count > 0 ? round(result.purchase_cost_usd / result.trade_count) : null;
    result.average_entry_rate_pct = result.average_entry_usd !== null
      ? round(result.average_entry_usd / definition.paper_equity_usd * 100)
      : null;
    result.profit_factor = result.gross_loss_usd > 0
      ? round(result.gross_profit_usd / result.gross_loss_usd, 3)
      : null;
    const deployedSeconds = capitalSeconds(intervals, definition.line_id, firstDate, lastDate);
    result.average_deployed_usd = denominatorSeconds > 0 ? round(deployedSeconds / denominatorSeconds) : 0;
    result.time_weighted_utilization_pct = denominatorSeconds > 0
      ? round(result.average_deployed_usd / definition.paper_equity_usd * 100, 3)
      : 0;
    result.open_contract_qty = openByLine.get(definition.line_id) || 0;
    return result;
  });
}

export function build_junk_performance_report({
  events = [],
  policy = {},
  experimentSummary = null,
  generatedAt = new Date(),
} = {}) {
  const definitions = lineDefinitions(policy);
  const trades = closedTrades(events);
  const pricedCloseKeys = new Set(trades.map((row) => `${row.plan_id}|${row.line_id}`));
  const entryKeys = new Set(events
    .filter((row) => row?.event === 'experiment_line_entry_allocated' && row.plan_id && row.line_id)
    .map((row) => `${row.plan_id}|${row.line_id}`));
  const intervals = exposureIntervals(events, pricedCloseKeys);
  const openByLine = openQtyByLine(events, experimentSummary);
  const activityDates = [...new Set([
    ...trades.map((row) => row.trading_date_et),
    ...events
      .filter((row) => row?.event === 'experiment_line_entry_allocated')
      .map((row) => trading_date_et(row.event_at)),
  ].filter(Boolean))].sort();
  const latestDate = activityDates.at(-1) || null;
  const firstDate = activityDates[0] || null;
  const empty = definitions.map(blankMetrics);
  return {
    schema_version: 1,
    generated_at: generatedAt instanceof Date ? generatedAt.toISOString() : new Date(generatedAt).toISOString(),
    title: 'JUNKMAN 收益报表',
    source: 'logs/zero-dte-options-trades.ndjson',
    pnl_basis: 'gross_option_price_change',
    fees_included: false,
    option_multiplier: OPTION_MULTIPLIER,
    account_equity_usd_per_line: 10_000,
    metric_definitions: {
      account_return_pct: '毛盈亏 / 每条线模拟账户本金 $10,000',
      turnover_return_pct: '毛盈亏 / 已完成交易累计买入成本',
      average_entry_rate_pct: '平均每笔买入成本 / $10,000',
      time_weighted_utilization_pct: '持仓金额按时间加权后的日均值 / $10,000；按美股常规交易时段估算',
    },
    available_dates: activityDates,
    latest_date_et: latestDate,
    first_date_et: firstDate,
    latest_day: {
      first_date_et: latestDate,
      last_date_et: latestDate,
      session_hours: latestDate ? regularSessionHours(latestDate) : 0,
      lines: latestDate
        ? summarizePeriod(definitions, trades, intervals, latestDate, latestDate, openByLine)
        : empty,
    },
    cumulative: {
      first_date_et: firstDate,
      last_date_et: latestDate,
      session_hours: firstDate && latestDate ? round(sessionSecondsBetween(firstDate, latestDate) / 3600, 1) : 0,
      lines: firstDate && latestDate
        ? summarizePeriod(definitions, trades, intervals, firstDate, latestDate, openByLine)
        : empty,
    },
    exclusions: {
      unpriced_or_incomplete_close_count: events.filter((row) => row?.event === 'experiment_line_position_closed')
        .filter((row) => !Number.isFinite(Number(row.entry_value))
          || !Number.isFinite(Number(row.exit_value))
          || !Number.isFinite(Number(row.realized_pnl_usd))).length,
      entry_without_priced_close_count: [...entryKeys].filter((key) => !pricedCloseKeys.has(key)).length,
    },
  };
}
