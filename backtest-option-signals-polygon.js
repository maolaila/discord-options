#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SIGNALS_FILE = path.join(ROOT, 'analysis', 'option_signals_winrate_ge_75_dedup.json');
const OUT_DIR = path.join(ROOT, 'analysis');
const RESULT_JSON = path.join(OUT_DIR, 'option_backtest_polygon_results.json');
const RESULT_CSV = path.join(OUT_DIR, 'option_backtest_polygon_trades.csv');

function parseArgs(argv) {
  const args = {
    apiKey: process.env.POLYGON_API_KEY || process.env.POLYGON_KEY || '',
    capital: 10000,
    limit: 0,
    entryWindowMinutes: 2,
    stopLossPct: 20,
    takeProfitPct: 50,
    sameMinutePriority: 'stop',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--api-key') args.apiKey = argv[++i] || '';
    else if (arg === '--capital') args.capital = Number(argv[++i] || args.capital);
    else if (arg === '--limit') args.limit = Number(argv[++i] || 0);
    else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage:
  node .\\backtest-option-signals-polygon.js --api-key <POLYGON_API_KEY>

Options:
  --capital <usd>   Total batch capital, default 10000
  --limit <n>       Only backtest first n signals
  -h, --help        Show help
`.trim());
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
}

function readSignals(file, limit) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  return limit > 0 ? rows.slice(0, limit) : rows;
}

function nyParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const out = {};
  for (const part of parts) out[part.type] = part.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour === '24' ? '0' : out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

function nyDateKey(date) {
  const p = nyParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function nyLocalToUtcMs(dateKey, hour, minute, second) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const start = Date.UTC(year, month - 1, day, hour + 3, minute, second);
  const end = Date.UTC(year, month - 1, day, hour + 8, minute, second);

  for (let ms = start; ms <= end; ms += 60 * 1000) {
    const p = nyParts(new Date(ms));
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute) {
      return Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate(), new Date(ms).getUTCHours(), new Date(ms).getUTCMinutes(), second);
    }
  }

  throw new Error(`Unable to resolve NY local time ${dateKey} ${hour}:${minute}:${second}`);
}

async function polygonAggs(ticker, fromMs, toMs, apiKey) {
  const url = new URL(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${fromMs}/${toMs}`);
  url.searchParams.set('adjusted', 'true');
  url.searchParams.set('sort', 'asc');
  url.searchParams.set('limit', '50000');
  url.searchParams.set('apiKey', apiKey);

  const response = await fetch(url);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Polygon returned non-JSON for ${ticker}: HTTP ${response.status}`);
  }

  if (!response.ok || body.status === 'ERROR') {
    throw new Error(`Polygon error for ${ticker}: HTTP ${response.status} ${body.error || body.message || text.slice(0, 200)}`);
  }

  return Array.isArray(body.results) ? body.results : [];
}

function barAtOrAfter(bars, startMs, endMs) {
  return bars.find((bar) => bar.t >= startMs && bar.t <= endMs) || null;
}

function barAtTime(bars, timeMs) {
  return bars.find((bar) => bar.t === timeMs) || null;
}

function lastBarAtOrBefore(bars, endMs) {
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    if (bars[i].t <= endMs) return bars[i];
  }
  return null;
}

function exitPriceForTime(optionBars, timeMs, fallbackPrice) {
  const bar = barAtTime(optionBars, timeMs);
  return bar ? bar.c : fallbackPrice;
}

function simulateTrade(signal, optionBars, stockBars, opts) {
  const signalMs = Date.parse(signal.timestamp);
  const entryEndMs = signalMs + opts.entryWindowMinutes * 60 * 1000;
  const entryBar = barAtOrAfter(optionBars, signalMs, entryEndMs);
  if (!entryBar) return { status: 'no_option_entry_bar' };

  const entryPrice = entryBar.c;
  const optionStop = entryPrice * (1 - opts.stopLossPct / 100);
  const optionTarget = entryPrice * (1 + opts.takeProfitPct / 100);

  const dateKey = nyDateKey(new Date(signalMs));
  const closeMs = nyLocalToUtcMs(dateKey, 16, 0, 0);
  const scanTimes = [...new Set([
    ...optionBars.map((bar) => bar.t),
    ...stockBars.map((bar) => bar.t),
  ])].filter((time) => time >= entryBar.t && time <= closeMs).sort((a, b) => a - b);

  let ambiguousTrigger = false;
  for (const time of scanTimes) {
    const optionBar = barAtTime(optionBars, time);
    const stockBar = barAtTime(stockBars, time);
    const triggers = [];

    if (optionBar && optionBar.l <= optionStop) triggers.push({ reason: 'option_20pct_stop', exitPrice: optionStop });
    if (optionBar && optionBar.h >= optionTarget) triggers.push({ reason: 'option_50pct_take_profit', exitPrice: optionTarget });

    if (stockBar && signal.direction === 'bull' && stockBar.l <= signal.stop_stock_price) {
      triggers.push({ reason: 'stock_stop_line', exitPrice: exitPriceForTime(optionBars, time, entryPrice) });
    }
    if (stockBar && signal.direction === 'bull' && stockBar.h >= signal.target_stock_price) {
      triggers.push({ reason: 'stock_target_line', exitPrice: exitPriceForTime(optionBars, time, entryPrice) });
    }
    if (stockBar && signal.direction === 'bear' && stockBar.h >= signal.stop_stock_price) {
      triggers.push({ reason: 'stock_stop_line', exitPrice: exitPriceForTime(optionBars, time, entryPrice) });
    }
    if (stockBar && signal.direction === 'bear' && stockBar.l <= signal.target_stock_price) {
      triggers.push({ reason: 'stock_target_line', exitPrice: exitPriceForTime(optionBars, time, entryPrice) });
    }

    if (triggers.length) {
      ambiguousTrigger = triggers.length > 1;
      const stop = triggers.find((trigger) => trigger.reason.includes('stop'));
      const chosen = opts.sameMinutePriority === 'stop' && stop ? stop : triggers[0];
      return {
        status: 'closed',
        entry_time: new Date(entryBar.t).toISOString(),
        exit_time: new Date(time).toISOString(),
        entry_price: entryPrice,
        exit_price: chosen.exitPrice,
        exit_reason: chosen.reason,
        return_pct: (chosen.exitPrice / entryPrice - 1) * 100,
        ambiguous_trigger: ambiguousTrigger,
      };
    }
  }

  const closeBar = lastBarAtOrBefore(optionBars, closeMs);
  if (!closeBar) return { status: 'no_option_close_bar', entry_price: entryPrice };

  return {
    status: 'closed',
    entry_time: new Date(entryBar.t).toISOString(),
    exit_time: new Date(closeBar.t).toISOString(),
    entry_price: entryPrice,
    exit_price: closeBar.c,
    exit_reason: 'close_before_market_close',
    return_pct: (closeBar.c / entryPrice - 1) * 100,
    ambiguous_trigger: false,
  };
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeCsv(file, rows) {
  const columns = [
    'message_id',
    'timestamp',
    'ticker',
    'polygon_option_ticker',
    'direction',
    'entry_stock_price',
    'target_stock_price',
    'stop_stock_price',
    'win_rate_pct',
    'status',
    'entry_time',
    'exit_time',
    'entry_price',
    'exit_price',
    'exit_reason',
    'return_pct',
    'pnl_usd',
    'ambiguous_trigger',
  ];
  const lines = [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(',')),
  ];
  fs.writeFileSync(file, `\ufeff${lines.join('\r\n')}\r\n`, 'utf8');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.apiKey) {
    console.error('Missing Polygon API key. Set POLYGON_API_KEY or pass --api-key.');
    process.exit(1);
  }

  const signals = readSignals(SIGNALS_FILE, opts.limit);
  const perTradeCapital = signals.length ? opts.capital / signals.length : 0;
  const cache = new Map();
  const results = [];

  for (let i = 0; i < signals.length; i += 1) {
    const signal = signals[i];
    const signalMs = Date.parse(signal.timestamp);
    const dateKey = nyDateKey(new Date(signalMs));
    const closeMs = nyLocalToUtcMs(dateKey, 16, 0, 0);
    const fromMs = signalMs;
    const toMs = closeMs;

    const optionKey = `${signal.polygon_option_ticker}|${fromMs}|${toMs}`;
    const stockKey = `${signal.ticker}|${fromMs}|${toMs}`;

    if (!cache.has(optionKey)) cache.set(optionKey, await polygonAggs(signal.polygon_option_ticker, fromMs, toMs, opts.apiKey));
    if (!cache.has(stockKey)) cache.set(stockKey, await polygonAggs(signal.ticker, fromMs, toMs, opts.apiKey));

    const simulated = simulateTrade(signal, cache.get(optionKey), cache.get(stockKey), opts);
    const pnl = simulated.return_pct === undefined ? null : perTradeCapital * simulated.return_pct / 100;
    results.push({
      ...signal,
      ...simulated,
      pnl_usd: pnl,
    });

    console.log(`${i + 1}/${signals.length} ${signal.polygon_option_ticker} ${simulated.status}${simulated.return_pct === undefined ? '' : ` ${simulated.return_pct.toFixed(2)}%`}`);
  }

  const closed = results.filter((row) => row.status === 'closed');
  const wins = closed.filter((row) => row.return_pct > 0);
  const summary = {
    generated_at: new Date().toISOString(),
    data_source: 'Polygon aggregates 1 minute',
    capital_usd: opts.capital,
    allocation_model: 'equal weight across all tested signals',
    tested_signals: signals.length,
    closed_trades: closed.length,
    skipped_trades: results.length - closed.length,
    win_rate_pct: closed.length ? wins.length / closed.length * 100 : null,
    total_pnl_usd: closed.reduce((sum, row) => sum + (row.pnl_usd || 0), 0),
    ending_equity_usd: opts.capital + closed.reduce((sum, row) => sum + (row.pnl_usd || 0), 0),
    average_return_pct: closed.length ? closed.reduce((sum, row) => sum + row.return_pct, 0) / closed.length : null,
    ambiguous_trigger_count: closed.filter((row) => row.ambiguous_trigger).length,
    assumptions: {
      entry: 'first available option 1-minute aggregate close within 2 minutes after signal timestamp',
      option_stop: 'exit at entry option price * 0.80 when option minute low breaches',
      option_take_profit: 'exit at entry option price * 1.50 when option minute high breaches',
      stock_line_exit: 'exit at same-minute option close when stock minute bar breaches target/stop',
      same_minute_multiple_triggers: opts.sameMinutePriority,
    },
  };

  fs.writeFileSync(RESULT_JSON, `${JSON.stringify({ summary, results }, null, 2)}\n`, 'utf8');
  writeCsv(RESULT_CSV, results);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
