#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const LOG_FILE = path.join(ROOT, 'logs', 'option-signals.ndjson');
const OUT_DIR = path.join(ROOT, 'analysis');
const CSV_FILE = path.join(OUT_DIR, 'collected-option-signals-detailed.csv');
const MD_FILE = path.join(OUT_DIR, 'collected-option-signals-latest.md');
const SUMMARY_FILE = path.join(OUT_DIR, 'collected-option-signals-summary.json');
const UTF8_BOM = '\ufeff';

const COLUMNS = [
  'row_no',
  'received_at',
  'received_at_jst',
  'message_timestamp',
  'message_timestamp_jst',
  'logged_at',
  'logged_at_jst',
  'message_to_received_lag_ms',
  'received_to_logged_lag_ms',
  'log_mode',
  'observed_via',
  'source',
  'event_type',
  'message_id',
  'channel_id',
  'guild_id',
  'author_username',
  'advice_format',
  'title',
  'description',
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
  'signal_actionable',
  'full_plan_ready',
  'order_intent',
  'management_mode',
  'gate_notes',
  'execution_view',
  'price_structure',
  'option_structure',
  'execution_plan',
  'invalidation',
  'risk_note',
  'signal_key',
];

const COLUMN_LABELS = {
  row_no: '序号',
  received_at: '收到时间UTC',
  received_at_jst: '收到时间JST',
  message_timestamp: 'Discord消息时间UTC',
  message_timestamp_jst: 'Discord消息时间JST',
  logged_at: '落库时间UTC',
  logged_at_jst: '落库时间JST',
  message_to_received_lag_ms: '消息到收到延迟ms',
  received_to_logged_lag_ms: '收到到落库延迟ms',
  log_mode: '日志模式',
  observed_via: '监听来源',
  source: '网络来源',
  event_type: '事件类型',
  message_id: '消息ID',
  channel_id: '频道ID',
  guild_id: '服务器ID',
  author_username: '作者',
  advice_format: '建议格式',
  title: '标题',
  description: '描述',
  ticker: '股票代码',
  expiration: '期权到期日',
  strike: '行权价',
  option_type: '期权类型',
  contract_key: '合约键',
  polygon_option_ticker: 'Polygon期权代码',
  occ_symbol: 'OCC代码',
  action: '交易动作',
  direction: '方向',
  entry_stock_price: '股票入场价',
  target_stock_price: '股票目标价',
  stop_stock_price: '股票止损价',
  win_rate_pct: '胜率%',
  risk_score: '风险分',
  confidence: '置信度',
  premium_usd: '权利金USD',
  signal_actionable: '是否可执行',
  full_plan_ready: '是否完整计划',
  order_intent: '下单意图',
  management_mode: '管理模式',
  gate_notes: '过滤备注',
  execution_view: '执行观点',
  price_structure: '价格结构',
  option_structure: '期权结构',
  execution_plan: '执行计划',
  invalidation: '失效条件',
  risk_note: '风险提示',
  signal_key: '信号键',
};

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  const text = stripBom(fs.readFileSync(file, 'utf8'));
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

function toJst(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const pad = (number) => String(number).padStart(2, '0');
  return [
    `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())}`,
    `${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}`,
  ].join(' ');
}

function clean(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join('; ');
  return String(value).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function csvEscape(value) {
  const text = clean(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function mdEscape(value) {
  return clean(value).replace(/\|/g, '\\|');
}

function rowValue(signal, column, index) {
  if (column === 'row_no') return index + 1;
  if (column === 'received_at_jst') return toJst(signal.received_at || signal.captured_at);
  if (column === 'message_timestamp_jst') return toJst(signal.message_timestamp);
  if (column === 'logged_at_jst') return toJst(signal.logged_at);
  if (column === 'gate_notes') return Array.isArray(signal.gate_notes) ? signal.gate_notes.join('; ') : signal.gate_notes;
  return signal[column];
}

function writeCsv(rows) {
  const lines = [
    COLUMNS.map((column) => csvEscape(COLUMN_LABELS[column] || column)).join(','),
    ...rows.map((row, index) => COLUMNS.map((column) => csvEscape(rowValue(row, column, index))).join(',')),
  ];
  fs.writeFileSync(CSV_FILE, `${UTF8_BOM}${lines.join('\n')}\n`, 'utf8');
}

function shortText(value, maxLength = 180) {
  const text = clean(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function writeMarkdown(rows, limit) {
  const latest = rows.slice(-limit).reverse();
  const lines = [
    '# 最新期权买卖意见列表',
    '',
    `生成时间: ${new Date().toISOString()}`,
    `数据来源: logs/option-signals.ndjson`,
    `显示行数: ${latest.length} / ${rows.length}`,
    '',
    '| 序号 | 收到时间JST | 落库延迟ms | 来源 | 频道ID | 标题 | 动作 | 方向 | 入场 | 目标 | 止损 | 胜率 | 置信 | 风险 | 权利金 | 状态 |',
    '|---:|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
  ];

  for (const signal of latest) {
    const rowNo = rows.indexOf(signal) + 1;
    lines.push([
      rowNo,
      mdEscape(toJst(signal.received_at || signal.captured_at)),
      mdEscape(signal.received_to_logged_lag_ms),
      mdEscape(signal.observed_via),
      mdEscape(signal.channel_id),
      mdEscape(signal.title),
      mdEscape(signal.action),
      mdEscape(signal.direction),
      mdEscape(signal.entry_stock_price),
      mdEscape(signal.target_stock_price),
      mdEscape(signal.stop_stock_price),
      mdEscape(signal.win_rate_pct),
      mdEscape(signal.confidence),
      mdEscape(signal.risk_score),
      mdEscape(signal.premium_usd),
      mdEscape(signal.full_plan_ready ? 'full' : signal.signal_actionable ? 'actionable' : 'no'),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push('', '## 明细行', '');
  for (const signal of latest) {
    const rowNo = rows.indexOf(signal) + 1;
    lines.push(
      `### 第 ${rowNo} 行 - ${clean(signal.title)}`,
      '',
      `- 时间: Discord消息=${clean(signal.message_timestamp)} 收到=${clean(signal.received_at || signal.captured_at)} 落库=${clean(signal.logged_at)} 收到到落库延迟=${clean(signal.received_to_logged_lag_ms)}ms`,
      `- 来源: ${clean(signal.observed_via)} ${clean(signal.event_type)} 频道=${clean(signal.channel_id)} 消息ID=${clean(signal.message_id)} 日志模式=${clean(signal.log_mode)}`,
      `- 合约: ${clean(signal.contract_key)} Polygon=${clean(signal.polygon_option_ticker)} OCC=${clean(signal.occ_symbol)}`,
      `- 判断: 动作=${clean(signal.action)} 方向=${clean(signal.direction)} 入场=${clean(signal.entry_stock_price)} 目标=${clean(signal.target_stock_price)} 止损=${clean(signal.stop_stock_price)} 胜率=${clean(signal.win_rate_pct)} 置信=${clean(signal.confidence)} 风险=${clean(signal.risk_score)} 完整计划=${clean(signal.full_plan_ready)}`,
      `- 权利金: ${clean(signal.premium_usd)} 描述=${clean(signal.description)}`,
      `- 执行观点: ${shortText(signal.execution_view, 260)}`,
      `- 执行计划: ${shortText(signal.execution_plan, 260)}`,
      `- 失效条件: ${shortText(signal.invalidation, 260)}`,
      `- 风险提示: ${shortText(signal.risk_note, 260)}`,
      `- 价格结构: ${shortText(signal.price_structure, 500)}`,
      ''
    );
  }

  fs.writeFileSync(MD_FILE, `${UTF8_BOM}${lines.join('\n')}\n`, 'utf8');
}

function summarize(rows) {
  const summary = {
    generated_at: new Date().toISOString(),
    source_file: path.relative(ROOT, LOG_FILE).replace(/\\/g, '/'),
    rows: rows.length,
    live_rows: rows.filter((row) => row.observed_via === 'LIVE_SIGNAL').length,
    rest_rows: rows.filter((row) => row.observed_via === 'REST_SIGNAL').length,
    actionable_rows: rows.filter((row) => row.signal_actionable).length,
    full_plan_rows: rows.filter((row) => row.full_plan_ready).length,
    trade_rows: rows.filter((row) => row.action === 'trade').length,
    no_trade_rows: rows.filter((row) => row.action === 'no_trade').length,
    win_rate_ge_75_rows: rows.filter((row) => Number(row.win_rate_pct) >= 75).length,
    live_capture_rows: rows.filter((row) => row.log_mode === 'live_capture').length,
    first_received_at: rows[0] ? rows[0].received_at || rows[0].captured_at : null,
    last_received_at: rows[rows.length - 1] ? rows[rows.length - 1].received_at || rows[rows.length - 1].captured_at : null,
    csv_file: path.relative(ROOT, CSV_FILE).replace(/\\/g, '/'),
    markdown_file: path.relative(ROOT, MD_FILE).replace(/\\/g, '/'),
  };
  fs.writeFileSync(SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = readJsonLines(LOG_FILE).sort((a, b) => {
    const left = Date.parse(a.received_at || a.captured_at || a.message_timestamp || 0);
    const right = Date.parse(b.received_at || b.captured_at || b.message_timestamp || 0);
    return left - right;
  });

  writeCsv(rows);
  writeMarkdown(rows, 120);
  const summary = summarize(rows);
  console.log(JSON.stringify(summary, null, 2));
}

main();
