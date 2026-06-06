import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  PROJECT_ROOT,
  QOT_MARKET_US_SECURITY,
  connectMoomoo,
  loadMoomooConfig,
  normalizeForJson,
} from './moomoo-opend.mjs';

const args = parseArgs(process.argv.slice(2));
const logsDir = path.join(PROJECT_ROOT, 'logs');
const outDir = path.join(PROJECT_ROOT, 'analysis');
const signalsPath = path.join(logsDir, 'option-signals.ndjson');
const resultJsonPath = path.join(outDir, 'strict-pa-moomoo-backtest-results.json');
const resultCsvPath = path.join(outDir, 'strict-pa-moomoo-backtest-trades.csv');
const portfolioJsonPath = path.join(outDir, 'strict-pa-moomoo-backtest-portfolio.json');
const portfolioHardcapJsonPath = path.join(outDir, 'strict-pa-moomoo-backtest-portfolio-hardcap.json');
const statusPath = path.join(outDir, 'strict-pa-moomoo-backtest-status.json');
const historyCacheDir = path.join(outDir, 'moomoo-history-cache');
let lastHistoryRequestAt = 0;

function parseArgs(argv) {
  const out = {
    env: '',
    limit: 0,
    entryWindowMinutes: 2,
    capitalUsd: 10000,
    sameMinutePriority: 'stop',
    maxSignals: 0,
    resume: false,
    waitForQuota: false,
    quotaSleepMinutes: 60,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--env') out.env = argv[++i] || '';
    else if (arg === '--limit') out.limit = Number(argv[++i] || 0);
    else if (arg === '--capital') out.capitalUsd = Number(argv[++i] || 10000);
    else if (arg === '--entry-window-minutes') out.entryWindowMinutes = Number(argv[++i] || 2);
    else if (arg === '--same-minute-priority') out.sameMinutePriority = argv[++i] || 'stop';
    else if (arg === '--resume') out.resume = true;
    else if (arg === '--wait-for-quota') out.waitForQuota = true;
    else if (arg === '--quota-sleep-minutes') out.quotaSleepMinutes = Number(argv[++i] || 60);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node .\\backtest-strict-pa-moomoo.mjs --env D:\\moomoo_trade_reports\\.env [--limit 20] [--resume] [--wait-for-quota]');
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return out;
}

function readNdjson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line.replace(/^\uFEFF/, '')));
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isStrictPa(signal, config) {
  return signal
    && signal.advice_format === config.requiredAdviceFormat
    && signal.action === 'trade'
    && signal.full_plan_ready === true
    && Number(signal.win_rate_pct) >= config.minWinRate
    && Number(signal.confidence) >= config.minConfidence
    && Number(signal.risk_score) <= config.maxRiskScore
    && numeric(signal.entry_stock_price) !== null
    && numeric(signal.target_stock_price) !== null
    && numeric(signal.stop_stock_price) !== null
    && ((signal.direction === 'bull' && signal.option_type === 'C') || (signal.direction === 'bear' && signal.option_type === 'P'));
}

function strictSignals(config) {
  const byMessageId = new Map();
  for (const row of readNdjson(signalsPath)) {
    if (!isStrictPa(row, config)) continue;
    const id = String(row.message_id || row.signal_key || '');
    if (!id) continue;
    const current = byMessageId.get(id);
    if (!current || sourceRank(row) < sourceRank(current)) byMessageId.set(id, row);
  }
  const rows = [...byMessageId.values()].sort((a, b) => Date.parse(a.message_timestamp || 0) - Date.parse(b.message_timestamp || 0));
  return args.limit > 0 ? rows.slice(0, args.limit) : rows;
}

function yymmdd(dateText) {
  return String(dateText || '').replace(/-/g, '').slice(2);
}

function moomooOptionCode(signal) {
  const strike = Math.round(Number(signal.strike) * 1000);
  return `${signal.ticker}${yymmdd(signal.expiration)}${signal.option_type}${strike}`;
}

function sourceRank(row) {
  if (row.event_type === 'REST_CHANNEL_MESSAGES') return 0;
  if (row.event_type === 'MESSAGE_CREATE') return 1;
  return 2;
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

function marketTimeString(signalDate, hour, minute, second) {
  return `${nyDateKey(signalDate)} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function barTimeMs(bar) {
  if (bar.timestamp !== undefined && bar.timestamp !== null) return Number(bar.timestamp) * 1000;
  return Date.parse(`${bar.time}Z`);
}

function normalizeBars(response) {
  return (normalizeForJson(response.s2c?.klList || []) || [])
    .filter((bar) => !bar.isBlank)
    .map((bar) => ({ ...bar, t: barTimeMs(bar) }))
    .sort((a, b) => a.t - b.t);
}

function errorMessage(error) {
  return error?.retMsg || error?.message || JSON.stringify(normalizeForJson(error));
}

function isFrequencyError(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('\u9891\u7387\u592a\u9ad8') || text.includes('rate') || text.includes('frequency') || text.includes('棰戠巼');
}

function isQuotaError(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('\u989d\u5ea6\u4e0d\u8db3') || text.includes('\u989d\u5ea6\u4f1a\u6eda\u52a8\u91ca\u653e') || text.includes('quota') || text.includes('棰濆害');
}

async function queryHistoryQuota(client, detail = false) {
  const response = await client.RequestHistoryKLQuota({ c2s: { bGetDetail: detail } });
  const normalized = normalizeForJson(response);
  return {
    usedQuota: Number(normalized.s2c?.usedQuota ?? 0),
    remainQuota: Number(normalized.s2c?.remainQuota ?? 0),
    detailList: normalizeForJson(normalized.s2c?.detailList || []),
  };
}

function writeStatus(status) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(statusPath, `${JSON.stringify({ updated_at: new Date().toISOString(), ...status }, null, 2)}\n`, 'utf8');
}

function contextFromSecurity(security) {
  return {
    security_market: security.market,
    security_code: security.code,
  };
}

async function waitForHistoryQuota(client, context = {}) {
  if (!args.waitForQuota) return;
  for (;;) {
    const quota = await queryHistoryQuota(client, false);
    if (quota.remainQuota > 0) {
      writeStatus({ phase: 'quota_available', quota, ...context });
      return;
    }
    const sleepMs = Math.max(1, args.quotaSleepMinutes) * 60 * 1000;
    const nextCheckAt = new Date(Date.now() + sleepMs).toISOString();
    writeStatus({ phase: 'waiting_for_history_quota', quota, next_check_at: nextCheckAt, ...context });
    console.log(`history quota exhausted: used=${quota.usedQuota} remain=${quota.remainQuota}; next check ${nextCheckAt}`);
    await sleep(sleepMs);
  }
}

function cacheKey(security, signalDate) {
  const code = String(security.code || '').replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${security.market}-${code}-${nyDateKey(signalDate)}.json`;
}

async function readCachedHistory(security, signalDate) {
  const filePath = path.join(historyCacheDir, cacheKey(security, signalDate));
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  return Array.isArray(parsed.bars) ? parsed.bars : null;
}

async function writeCachedHistory(security, signalDate, bars) {
  await fsp.mkdir(historyCacheDir, { recursive: true });
  const filePath = path.join(historyCacheDir, cacheKey(security, signalDate));
  const payload = {
    cached_at: new Date().toISOString(),
    security,
    date: nyDateKey(signalDate),
    bars,
  };
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function requestHistoryKlCached(client, security, signalDate, context = {}) {
  const cached = await readCachedHistory(security, signalDate);
  if (cached) return cached;
  const bars = await requestHistoryKl(client, security, signalDate, context);
  await writeCachedHistory(security, signalDate, bars);
  return bars;
}

async function requestHistoryKl(client, security, signalDate, context = {}) {
  const request = {
    c2s: {
      rehabType: 0,
      klType: 1,
      security,
      beginTime: marketTimeString(signalDate, 9, 30, 0),
      endTime: marketTimeString(signalDate, 16, 0, 0),
      maxAckKLNum: 1000,
    },
  };
  for (let attempt = 0; ; attempt += 1) {
    await waitForHistoryQuota(client, { ...contextFromSecurity(security), ...context });
    await throttleHistoryRequests();
    try {
      const response = await client.RequestHistoryKL(request);
      return normalizeBars(response);
    } catch (error) {
      const msg = errorMessage(error);
      if (isFrequencyError(msg) && attempt < 2) {
        await sleep(31000);
        continue;
      }
      if (isQuotaError(msg) && args.waitForQuota) {
        const sleepMs = Math.max(1, args.quotaSleepMinutes) * 60 * 1000;
        const nextCheckAt = new Date(Date.now() + sleepMs).toISOString();
        writeStatus({ phase: 'waiting_for_history_quota_error', error: msg, next_check_at: nextCheckAt, ...contextFromSecurity(security), ...context });
        console.log(`history quota error for ${security.code}: ${msg}; next check ${nextCheckAt}`);
        await sleep(sleepMs);
        continue;
      }
      if (msg.includes('频率太高') && attempt < 2) {
        await sleep(31000);
        continue;
      }
      throw error;
    }
  }
  return [];
}

async function throttleHistoryRequests() {
  const elapsed = Date.now() - lastHistoryRequestAt;
  const waitMs = 650 - elapsed;
  if (waitMs > 0) await sleep(waitMs);
  lastHistoryRequestAt = Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function barAtOrAfter(bars, startMs, endMs) {
  return bars.find((bar) => bar.t >= startMs && bar.t <= endMs) || null;
}

function barAtTimeOrNearestAfter(bars, timeMs) {
  return bars.find((bar) => bar.t >= timeMs) || null;
}

function lastBarAtOrBefore(bars, endMs) {
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    if (bars[i].t <= endMs) return bars[i];
  }
  return null;
}

function stockTrigger(signal, stockBar, underlyingEntry, config) {
  const triggers = [];
  const direction = signal.direction;
  const signalTarget = Number(signal.target_stock_price);
  const signalStop = Number(signal.stop_stock_price);
  const pctTarget = direction === 'bull'
    ? underlyingEntry * (1 + config.underlyingTakeProfitPct / 100)
    : underlyingEntry * (1 - config.underlyingTakeProfitPct / 100);
  const pctStop = direction === 'bull'
    ? underlyingEntry * (1 - config.underlyingStopLossPct / 100)
    : underlyingEntry * (1 + config.underlyingStopLossPct / 100);

  if (direction === 'bull') {
    if (stockBar.highPrice >= signalTarget) triggers.push({ reason: 'signal_stock_target', line: signalTarget, type: 'profit' });
    if (stockBar.lowPrice <= signalStop) triggers.push({ reason: 'signal_stock_stop', line: signalStop, type: 'stop' });
    if (stockBar.highPrice >= pctTarget) triggers.push({ reason: 'underlying_50pct_take_profit', line: pctTarget, type: 'profit' });
    if (stockBar.lowPrice <= pctStop) triggers.push({ reason: 'underlying_20pct_stop_loss', line: pctStop, type: 'stop' });
  } else {
    if (stockBar.lowPrice <= signalTarget) triggers.push({ reason: 'signal_stock_target', line: signalTarget, type: 'profit' });
    if (stockBar.highPrice >= signalStop) triggers.push({ reason: 'signal_stock_stop', line: signalStop, type: 'stop' });
    if (stockBar.lowPrice <= pctTarget) triggers.push({ reason: 'underlying_50pct_take_profit', line: pctTarget, type: 'profit' });
    if (stockBar.highPrice >= pctStop) triggers.push({ reason: 'underlying_20pct_stop_loss', line: pctStop, type: 'stop' });
  }
  return triggers;
}

function calculateQty(entryOptionPrice, multiplier, config) {
  const contractCost = entryOptionPrice * multiplier;
  const targetBudget = config.paperEquityUsd * config.targetPositionPct / 100;
  const maxBudget = config.paperEquityUsd * config.maxPositionPct / 100;
  const maxQty = Math.floor(maxBudget / contractCost);
  if (maxQty < 1) return { qty: 0, contractCost, estimatedPositionUsd: 0, estimatedPositionPct: 0 };
  const qty = Math.min(Math.max(1, Math.round(targetBudget / contractCost)), maxQty);
  const estimatedPositionUsd = qty * contractCost;
  return {
    qty,
    contractCost,
    estimatedPositionUsd,
    estimatedPositionPct: estimatedPositionUsd / config.paperEquityUsd * 100,
  };
}

function simulate(signal, optionBars, stockBars, contract, config) {
  const signalMs = Date.parse(signal.message_timestamp);
  const entryEndMs = signalMs + args.entryWindowMinutes * 60 * 1000;
  const entryOptionBar = barAtOrAfter(optionBars, signalMs, entryEndMs);
  if (!entryOptionBar) return { status: 'no_option_entry_bar' };

  const entryStockBar = barAtTimeOrNearestAfter(stockBars, entryOptionBar.t);
  if (!entryStockBar) return { status: 'no_stock_entry_bar' };

  const underlyingEntry = Number(entryStockBar.closePrice);
  const entryOptionPrice = Number(entryOptionBar.closePrice);
  if (!Number.isFinite(entryOptionPrice) || entryOptionPrice <= 0) return { status: 'invalid_option_entry_price' };

  const closeBar = lastBarAtOrBefore(optionBars, Date.parse(`${nyDateKey(new Date(signalMs))}T20:00:00Z`)) || optionBars[optionBars.length - 1];
  const scanTimes = [...new Set(stockBars.map((bar) => bar.t))]
    .filter((time) => time >= entryOptionBar.t)
    .sort((a, b) => a - b);

  let exitStockBar = null;
  let exitOptionBar = null;
  let exitReason = 'close_before_market_close';
  let triggerLine = null;
  let ambiguousTrigger = false;

  for (const time of scanTimes) {
    const stockBar = stockBars.find((bar) => bar.t === time);
    if (!stockBar) continue;
    const triggers = stockTrigger(signal, stockBar, underlyingEntry, config);
    if (!triggers.length) continue;
    ambiguousTrigger = triggers.length > 1;
    const chosen = args.sameMinutePriority === 'stop'
      ? (triggers.find((trigger) => trigger.type === 'stop') || triggers[0])
      : triggers[0];
    exitStockBar = stockBar;
    exitOptionBar = barAtTimeOrNearestAfter(optionBars, time) || closeBar;
    exitReason = chosen.reason;
    triggerLine = chosen.line;
    break;
  }

  if (!exitOptionBar) {
    exitOptionBar = closeBar;
    exitStockBar = lastBarAtOrBefore(stockBars, exitOptionBar.t);
  }
  if (!exitOptionBar) return { status: 'no_option_exit_bar', entry_option_price: entryOptionPrice };

  const exitOptionPrice = Number(exitOptionBar.closePrice);
  const multiplier = numeric(contract.raw?.optionExData?.contractMultiplier)
    || numeric(contract.raw?.optionExData?.contractSizeFloat)
    || numeric(contract.raw?.optionExData?.contractSize)
    || numeric(contract.lotSize)
    || config.contractMultiplierDefault;
  const sizing = calculateQty(entryOptionPrice, multiplier, config);
  const pnlUsd = sizing.qty * multiplier * (exitOptionPrice - entryOptionPrice);

  return {
    status: sizing.qty > 0 ? 'closed' : 'position_too_expensive',
    entry_time: entryOptionBar.time,
    exit_time: exitOptionBar.time,
    entry_option_price: entryOptionPrice,
    exit_option_price: exitOptionPrice,
    entry_underlying_price: underlyingEntry,
    exit_underlying_price: Number(exitStockBar?.closePrice ?? NaN),
    exit_reason: exitReason,
    trigger_line: triggerLine,
    return_pct: (exitOptionPrice / entryOptionPrice - 1) * 100,
    qty: sizing.qty,
    contract_multiplier: multiplier,
    estimated_position_usd: sizing.estimatedPositionUsd,
    estimated_position_pct: sizing.estimatedPositionPct,
    pnl_usd: pnlUsd,
    ambiguous_trigger: ambiguousTrigger,
  };
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, rows) {
  const columns = [
    'message_id', 'message_timestamp', 'ticker', 'expiration', 'strike', 'option_type', 'direction',
    'win_rate_pct', 'confidence', 'risk_score', 'moomoo_option_code', 'contract_source', 'status',
    'entry_time', 'exit_time', 'entry_underlying_price', 'exit_underlying_price',
    'entry_option_price', 'exit_option_price', 'exit_reason', 'trigger_line',
    'qty', 'estimated_position_usd', 'estimated_position_pct', 'return_pct', 'pnl_usd',
  ];
  const lines = [columns.join(','), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(','))];
  fs.writeFileSync(filePath, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

function summarize(results, config) {
  const closed = results.filter((row) => row.status === 'closed');
  const wins = closed.filter((row) => row.pnl_usd > 0);
  const totalPnl = closed.reduce((sum, row) => sum + Number(row.pnl_usd || 0), 0);
  const returns = closed.map((row) => Number(row.return_pct || 0)).sort((a, b) => a - b);
  return {
    generated_at: new Date().toISOString(),
    data_source: 'Moomoo OpenD RequestHistoryKL 1-minute bars',
    policy: {
      advice_format: config.requiredAdviceFormat,
      min_win_rate_pct: config.minWinRate,
      min_confidence: config.minConfidence,
      max_risk_score: config.maxRiskScore,
      paper_equity_usd: config.paperEquityUsd,
      target_position_pct: config.targetPositionPct,
      max_position_pct: config.maxPositionPct,
      underlying_take_profit_pct: config.underlyingTakeProfitPct,
      underlying_stop_loss_pct: config.underlyingStopLossPct,
    },
    total_signals: results.length,
    closed_trades: closed.length,
    skipped_trades: results.length - closed.length,
    win_rate_pct: closed.length ? wins.length / closed.length * 100 : null,
    total_pnl_usd: totalPnl,
    ending_equity_if_independent_10000_usd: config.paperEquityUsd + totalPnl,
    average_trade_return_pct: closed.length ? closed.reduce((sum, row) => sum + Number(row.return_pct || 0), 0) / closed.length : null,
    median_trade_return_pct: returns.length ? (returns.length % 2 ? returns[Math.floor(returns.length / 2)] : (returns[returns.length / 2 - 1] + returns[returns.length / 2]) / 2) : null,
    by_status: Object.fromEntries([...new Set(results.map((row) => row.status))].map((status) => [status, results.filter((row) => row.status === status).length])),
    by_exit_reason: Object.fromEntries([...new Set(closed.map((row) => row.exit_reason))].map((reason) => [reason, closed.filter((row) => row.exit_reason === reason).length])),
    assumptions: [
      'Entry is the first option 1-minute close at or after message_timestamp within 2 minutes.',
      'Underlying entry price is the stock 1-minute close at the option entry minute.',
      'Underlying stock bars trigger exits; option close at that minute is used for actual option PnL.',
      'If no trigger fires, exit uses the last available option 1-minute close before regular close.',
      'Position size uses 10000 USD paper equity and approximately 25% per trade, capped at 30%.',
      'This is per-signal PnL, not cash-constrained portfolio scheduling.',
    ],
  };
}

function parseMarketTimestamp(timeText) {
  if (!timeText) return Number.NaN;
  return Date.parse(`${String(timeText).replace(' ', 'T')}-04:00`);
}

function portfolioBacktest(results, config, hardOpenCap = false) {
  const trades = results
    .filter((row) => row.status === 'closed')
    .map((row) => ({
      ...row,
      entryMs: parseMarketTimestamp(row.entry_time),
      exitMs: parseMarketTimestamp(row.exit_time),
      cost: Number(row.estimated_position_usd || 0),
      pnl: Number(row.pnl_usd || 0),
    }))
    .filter((row) => Number.isFinite(row.entryMs) && Number.isFinite(row.exitMs) && row.cost > 0)
    .sort((a, b) => a.entryMs - b.entryMs || String(a.message_id).localeCompare(String(b.message_id)));

  const startingCash = Number(config.paperEquityUsd || 10000);
  let cash = startingCash;
  let maxOpenCost = 0;
  const open = [];
  const taken = [];
  const skipped = [];

  for (const trade of trades) {
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (open[i].exitMs <= trade.entryMs) {
        cash += open[i].cost + open[i].pnl;
        open.splice(i, 1);
      }
    }

    const openCost = open.reduce((sum, row) => sum + row.cost, 0);
    maxOpenCost = Math.max(maxOpenCost, openCost);
    const capOk = !hardOpenCap || openCost + trade.cost <= startingCash + 1e-9;
    const cashOk = trade.cost <= cash + 1e-9;

    if (cashOk && capOk) {
      cash -= trade.cost;
      open.push(trade);
      taken.push(trade);
      maxOpenCost = Math.max(maxOpenCost, openCost + trade.cost);
    } else {
      skipped.push({
        ...trade,
        cash_at_entry: cash,
        open_cost: openCost,
        skip_reason: cashOk ? 'hard_open_cap' : 'cash',
      });
    }
  }

  for (const trade of open) cash += trade.cost + trade.pnl;

  const wins = taken.filter((row) => row.pnl > 0).length;
  const losses = taken.filter((row) => row.pnl < 0).length;
  const flat = taken.filter((row) => row.pnl === 0).length;
  const totalPnl = taken.reduce((sum, row) => sum + row.pnl, 0);

  return {
    summary: {
      generated_at: new Date().toISOString(),
      hard_open_position_cap_usd: hardOpenCap ? startingCash : null,
      starting_cash_usd: startingCash,
      ending_cash_usd: Number(cash.toFixed(2)),
      total_pnl_usd: Number(totalPnl.toFixed(2)),
      return_pct: Number((totalPnl / startingCash * 100).toFixed(2)),
      available_closed_trades: trades.length,
      taken_trades: taken.length,
      skipped_due_to_cash_or_cap: skipped.length,
      win_rate_pct: taken.length ? Number((wins / taken.length * 100).toFixed(2)) : null,
      wins,
      losses,
      flat,
      max_open_cost_usd: Number(maxOpenCost.toFixed(2)),
    },
    taken,
    skipped_due_to_cash_or_cap: skipped,
  };
}

function writePortfolioOutputs(results, config) {
  fs.writeFileSync(portfolioJsonPath, `${JSON.stringify(portfolioBacktest(results, config, false), null, 2)}\n`, 'utf8');
  fs.writeFileSync(portfolioHardcapJsonPath, `${JSON.stringify(portfolioBacktest(results, config, true), null, 2)}\n`, 'utf8');
}

function loadExistingResults() {
  if (!args.resume || !fs.existsSync(resultJsonPath)) return new Map();
  const parsed = JSON.parse(fs.readFileSync(resultJsonPath, 'utf8'));
  const out = new Map();
  for (const row of parsed.results || []) {
    if (row?.message_id) out.set(String(row.message_id), row);
  }
  return out;
}

function shouldRetryExisting(row) {
  if (!row) return true;
  return row.status === 'error' && isQuotaError(row.error || row.retMsg || row.message || '');
}

function rowsInSignalOrder(signals, resultsById) {
  return signals.map((signal) => {
    const id = String(signal.message_id || signal.signal_key || '');
    return resultsById.get(id) || { ...baseRow(signal), status: 'pending' };
  });
}

function writeOutputs(signals, resultsById, config) {
  const results = rowsInSignalOrder(signals, resultsById);
  const summary = summarize(results, config);
  fs.writeFileSync(resultJsonPath, `${JSON.stringify({ summary, results }, null, 2)}\n`, 'utf8');
  writeCsv(resultCsvPath, results);
  writePortfolioOutputs(results, config);
  return { summary, results };
}

async function main() {
  await fsp.mkdir(outDir, { recursive: true });
  const config = loadMoomooConfig({ envFile: args.env });
  const signals = strictSignals(config);
  const contractCache = new Map();
  const barsCache = new Map();
  const resultsById = loadExistingResults();
  let conn;

  try {
    conn = await connectMoomoo(config);
    for (let i = 0; i < signals.length; i += 1) {
      const signal = signals[i];
      const signalId = String(signal.message_id || signal.signal_key || '');
      const existing = resultsById.get(signalId);
      if (existing && !shouldRetryExisting(existing)) {
        console.log(`${i + 1}/${signals.length} ${signal.ticker} skip ${existing.status}`);
        continue;
      }
      const signalDate = new Date(signal.message_timestamp);
      const contractKey = `${signal.ticker}|${signal.expiration}|${signal.strike}|${signal.option_type}`;
      try {
        if (!contractCache.has(contractKey)) {
          contractCache.set(contractKey, {
            found: true,
            source: 'derived_code',
            contract: {
              security: {
                market: QOT_MARKET_US_SECURITY,
                code: moomooOptionCode(signal),
              },
              name: `${signal.ticker} ${signal.expiration} ${signal.strike}${signal.option_type}`,
              lotSize: config.contractMultiplierDefault,
              raw: {},
            },
          });
        }
        const resolved = contractCache.get(contractKey);
        if (!resolved.found) {
          resultsById.set(signalId, { ...baseRow(signal), status: 'contract_not_found' });
          writeOutputs(signals, resultsById, config);
          continue;
        }
        const contract = resolved.contract;
        const stockKey = `stock|${signal.ticker}|${nyDateKey(signalDate)}`;
        const optionKey = `option|${contract.security.code}|${nyDateKey(signalDate)}`;
        if (!barsCache.has(stockKey)) {
          barsCache.set(stockKey, await requestHistoryKlCached(conn.client, { market: QOT_MARKET_US_SECURITY, code: signal.ticker }, signalDate, {
            progress: `${i + 1}/${signals.length}`,
            message_id: signalId,
            ticker: signal.ticker,
            leg: 'stock',
          }));
        }
        if (!barsCache.has(optionKey)) {
          barsCache.set(optionKey, await requestHistoryKlCached(conn.client, contract.security, signalDate, {
            progress: `${i + 1}/${signals.length}`,
            message_id: signalId,
            ticker: signal.ticker,
            leg: 'option',
          }));
        }
        const simulated = simulate(signal, barsCache.get(optionKey), barsCache.get(stockKey), contract, config);
        resultsById.set(signalId, {
          ...baseRow(signal),
          moomoo_option_code: contract.security.code,
          contract_source: resolved.source,
          ...simulated,
        });
        writeOutputs(signals, resultsById, config);
        console.log(`${i + 1}/${signals.length} ${signal.ticker} ${signal.expiration} ${signal.strike}${signal.option_type} ${simulated.status}${simulated.return_pct === undefined ? '' : ` ${simulated.return_pct.toFixed(2)}%`}`);
      } catch (error) {
        const msg = errorMessage(error);
        resultsById.set(signalId, { ...baseRow(signal), status: 'error', error: msg });
        writeOutputs(signals, resultsById, config);
        console.log(`${i + 1}/${signals.length} ${signal.ticker} error ${msg}`);
      }
    }
  } finally {
    conn?.close();
  }

  const { summary } = writeOutputs(signals, resultsById, config);
  writeStatus({ phase: 'complete', summary });
  console.log(JSON.stringify(summary, null, 2));
}

function baseRow(signal) {
  return {
    message_id: signal.message_id,
    message_timestamp: signal.message_timestamp,
    ticker: signal.ticker,
    expiration: signal.expiration,
    strike: signal.strike,
    option_type: signal.option_type,
    direction: signal.direction,
    win_rate_pct: signal.win_rate_pct,
    confidence: signal.confidence,
    risk_score: signal.risk_score,
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
