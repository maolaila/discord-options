#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const LOG_FILE = path.join(ROOT, 'logs', 'history-messages.ndjson');
const OUT_DIR = path.join(ROOT, 'analysis');

const ALL_CSV = path.join(OUT_DIR, 'option_signals_all.csv');
const ELIGIBLE_CSV = path.join(OUT_DIR, 'option_signals_winrate_ge_75.csv');
const DEDUP_CSV = path.join(OUT_DIR, 'option_signals_winrate_ge_75_dedup.csv');
const DEDUP_JSON = path.join(OUT_DIR, 'option_signals_winrate_ge_75_dedup.json');
const SUMMARY_JSON = path.join(OUT_DIR, 'option_signals_summary.json');

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];

  const text = stripBom(fs.readFileSync(file, 'utf8'));
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    records.push(JSON.parse(line));
  }
  return records;
}

function fieldMap(embed) {
  const out = {};
  for (const field of embed && Array.isArray(embed.fields) ? embed.fields : []) {
    out[field.name] = field.value || '';
  }
  return out;
}

function parseTitle(title) {
  const match = String(title || '').match(/^([A-Z][A-Z0-9.-]*)\s+(\d{4}-\d{2}-\d{2})\s+([0-9]+(?:\.[0-9]+)?)([CP])\s+\|/);
  if (!match) return null;
  return {
    ticker: match[1],
    expiration: match[2],
    strike: Number(match[3]),
    option_type: match[4],
  };
}

function parsePremium(description) {
  const match = String(description || '').match(/Premium\s+\$([0-9,]+(?:\.\d+)?)/i);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function parseNumberAfter(label, text) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp(`${escaped}\\s*([0-9]+(?:\\.[0-9]+)?)`));
  return match ? Number(match[1]) : null;
}

function parseDirection(text) {
  const match = String(text || '').match(/\b(bull|bear|neutral)\b/i);
  return match ? match[1].toLowerCase() : null;
}

function parseAction(text) {
  if (String(text || '').includes('不交易')) return 'no_trade';
  if (String(text || '').includes('交易')) return 'trade';
  return null;
}

function parseWinRate(text) {
  const match = String(text || '').match(/胜率\s*([0-9]+(?:\.[0-9]+)?)%/);
  return match ? Number(match[1]) : null;
}

function parseRisk(text) {
  const match = String(text || '').match(/风险\s*([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : null;
}

function parseConfidence(text) {
  const match = String(text || '').match(/置信\s*([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : null;
}

function toTimestampSecond(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function yyyymmdd(value) {
  return String(value || '').replace(/-/g, '');
}

function polygonOptionTicker(ticker, expiration, optionType, strike) {
  const yyMMdd = yyyymmdd(expiration).slice(2);
  const strikeInt = Math.round(Number(strike) * 1000);
  return `O:${ticker}${yyMMdd}${optionType}${String(strikeInt).padStart(8, '0')}`;
}

function occSymbol(ticker, expiration, optionType, strike) {
  const yyMMdd = yyyymmdd(expiration).slice(2);
  const strikeInt = Math.round(Number(strike) * 1000);
  return `${ticker.padEnd(6, ' ')}${yyMMdd}${optionType}${String(strikeInt).padStart(8, '0')}`;
}

function parseSignal(record) {
  const embed = record.embeds && record.embeds[0];
  if (!embed) return null;

  const title = embed.title || '';
  const titleParts = parseTitle(title);
  if (!titleParts) return null;

  const fields = fieldMap(embed);
  const executionText = fields['执行观点'] || '';
  const planText = fields['执行计划'] || executionText;
  const invalidationText = fields['失效条件'] || '';
  const riskText = fields['风险提示'] || '';
  const optionStructureText = fields['期权结构'] || '';

  const entry = parseNumberAfter('入场', planText) ?? parseNumberAfter('入场', executionText);
  const target = parseNumberAfter('目标', planText) ?? parseNumberAfter('目标', executionText);
  const stop = parseNumberAfter('止损', planText) ?? parseNumberAfter('止损', executionText);
  const direction = parseDirection(executionText) || parseDirection(optionStructureText);
  const action = parseAction(executionText);
  const winRate = parseWinRate(invalidationText);

  const timestampSecond = toTimestampSecond(record.timestamp);
  const contractKey = `${titleParts.ticker}_${titleParts.expiration}_${titleParts.strike}${titleParts.option_type}`;

  return {
    message_id: record.id || '',
    channel_id: record.channel_id || '',
    timestamp: record.timestamp || '',
    timestamp_second: timestampSecond,
    captured_at: record.captured_at || '',
    author_username: record.author && record.author.username ? record.author.username : '',
    source: record.source || '',
    ticker: titleParts.ticker,
    expiration: titleParts.expiration,
    strike: titleParts.strike,
    option_type: titleParts.option_type,
    contract_key: contractKey,
    polygon_option_ticker: polygonOptionTicker(titleParts.ticker, titleParts.expiration, titleParts.option_type, titleParts.strike),
    occ_symbol: occSymbol(titleParts.ticker, titleParts.expiration, titleParts.option_type, titleParts.strike),
    action,
    direction,
    entry_stock_price: entry,
    target_stock_price: target,
    stop_stock_price: stop,
    win_rate_pct: winRate,
    risk_score: parseRisk(riskText),
    confidence: parseConfidence(riskText) ?? parseConfidence(optionStructureText),
    premium_usd: parsePremium(embed.description),
    title,
    description: embed.description || '',
    execution_view: executionText,
    price_structure: fields['价格结构'] || '',
    option_structure: optionStructureText,
    execution_plan: planText,
    invalidation: invalidationText,
    risk_note: riskText,
    is_trade: action === 'trade',
    is_eligible_75: action === 'trade' && winRate !== null && winRate >= 75 && entry !== null && target !== null && stop !== null,
  };
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeCsv(file, rows, columns) {
  const lines = [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(',')),
  ];
  fs.writeFileSync(file, `\ufeff${lines.join('\r\n')}\r\n`, 'utf8');
}

function dedupeSignals(rows) {
  const seen = new Map();

  for (const row of rows) {
    const key = [
      row.timestamp_second,
      row.contract_key,
      row.direction,
      row.entry_stock_price,
      row.target_stock_price,
      row.stop_stock_price,
      row.win_rate_pct,
    ].join('|');

    const current = seen.get(key);
    if (!current || String(row.message_id) < String(current.message_id)) {
      seen.set(key, row);
    }
  }

  return [...seen.values()].sort((a, b) => {
    const ta = a.timestamp_second || '';
    const tb = b.timestamp_second || '';
    if (ta !== tb) return ta.localeCompare(tb);
    return String(a.message_id).localeCompare(String(b.message_id));
  });
}

function countBy(rows, key) {
  const out = {};
  for (const row of rows) {
    const value = row[key] || '';
    out[value] = (out[value] || 0) + 1;
  }
  return out;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const records = readJsonLines(LOG_FILE);
  const parsed = records.map(parseSignal).filter(Boolean);
  const eligible = parsed.filter((row) => row.is_eligible_75);
  const deduped = dedupeSignals(eligible);

  const columns = [
    'message_id',
    'channel_id',
    'timestamp',
    'timestamp_second',
    'captured_at',
    'source',
    'ticker',
    'expiration',
    'strike',
    'option_type',
    'contract_key',
    'polygon_option_ticker',
    'occ_symbol',
    'action',
    'direction',
    'entry_stock_price',
    'target_stock_price',
    'stop_stock_price',
    'win_rate_pct',
    'risk_score',
    'confidence',
    'premium_usd',
    'title',
    'description',
    'execution_view',
    'price_structure',
    'option_structure',
    'execution_plan',
    'invalidation',
    'risk_note',
    'is_trade',
    'is_eligible_75',
  ];

  writeCsv(ALL_CSV, parsed, columns);
  writeCsv(ELIGIBLE_CSV, eligible, columns);
  writeCsv(DEDUP_CSV, deduped, columns);
  fs.writeFileSync(DEDUP_JSON, `${JSON.stringify(deduped, null, 2)}\n`, 'utf8');

  const summary = {
    input_file: path.relative(ROOT, LOG_FILE).replace(/\\/g, '/'),
    generated_at: new Date().toISOString(),
    raw_history_records: records.length,
    parsed_option_signals: parsed.length,
    trade_signals: parsed.filter((row) => row.is_trade).length,
    eligible_winrate_ge_75: eligible.length,
    eligible_winrate_ge_75_deduped: deduped.length,
    by_option_type: countBy(eligible, 'option_type'),
    by_direction: countBy(eligible, 'direction'),
    by_ticker_top_20: Object.fromEntries(
      Object.entries(countBy(eligible, 'ticker'))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
    ),
    outputs: {
      all_csv: path.relative(ROOT, ALL_CSV).replace(/\\/g, '/'),
      eligible_csv: path.relative(ROOT, ELIGIBLE_CSV).replace(/\\/g, '/'),
      dedup_csv: path.relative(ROOT, DEDUP_CSV).replace(/\\/g, '/'),
      dedup_json: path.relative(ROOT, DEDUP_JSON).replace(/\\/g, '/'),
    },
  };

  fs.writeFileSync(SUMMARY_JSON, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main();
