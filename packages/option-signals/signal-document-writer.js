'use strict';

const fs = require('fs');
const path = require('path');

const UTF8_BOM_TEXT = '\ufeff';
const ensuredSignalDocs = new Set();

function diffIsoMs(startIso, endIso) {
  const start = Date.parse(startIso || '');
  const end = Date.parse(endIso || '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return end - start;
}

function resolveTimeZone(timeZone) {
  const fallback = 'UTC';
  const candidate = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

function dateKeyForIso(iso, timeZone) {
  const date = new Date(iso || Date.now());
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function numberText(value) {
  return value === null || value === undefined || value === '' ? '-' : String(value);
}

function msText(value) {
  return value === null || value === undefined ? '-' : `${value} ms`;
}

function fenceText(value) {
  return String(value || '').replace(/```/g, "'''").trim();
}

function ensureTextFileWithBom(file, initialText) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    fs.writeFileSync(file, `${UTF8_BOM_TEXT}${initialText}`, 'utf8');
    return;
  }

  const text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) return;
  fs.writeFileSync(file, `${UTF8_BOM_TEXT}${text}`, 'utf8');
}

function stampSignalLogTimes(signal, loggedAt = new Date().toISOString(), mode = 'live_capture') {
  const receivedAt = signal.captured_at || signal.observed_at || signal.message_timestamp || '';
  signal.received_at = receivedAt;
  signal.logged_at = loggedAt;
  signal.documented_at = signal.documented_at || loggedAt;
  signal.log_mode = mode;
  signal.message_to_received_lag_ms = diffIsoMs(signal.message_timestamp, receivedAt);
  signal.received_to_logged_lag_ms = diffIsoMs(receivedAt, loggedAt);
  signal.received_to_document_lag_ms = diffIsoMs(receivedAt, signal.documented_at);
  return signal;
}

function ensureDailySignalDoc(file, dateKey, timeZone) {
  const header = [
    `# 期权买卖意见 ${dateKey}`,
    '',
    `- 日期口径: 监听收到时间 received_at，按 ${resolveTimeZone(timeZone)} 分组`,
    '- 时间字段: Discord消息时间 message_timestamp；监听收到时间 received_at；落库/写入时间 logged_at',
    '- 延迟字段: message_to_received_lag_ms = 监听收到时间 - Discord消息时间；received_to_logged_lag_ms = 落库/写入时间 - 监听收到时间',
    '',
  ].join('\n');
  ensureTextFileWithBom(file, header);
}

function addLine(lines, label, value) {
  if (value === null || value === undefined || value === '') return;
  lines.push(`- ${label}: ${oneLine(value)}`);
}

function addBlock(lines, label, value) {
  const clean = fenceText(value);
  if (!clean) return;
  lines.push('', `**${label}**`, '', '```text', clean, '```');
}

function buildSignalMarkdownBlock(signal, record, intent) {
  const readyText = signal.full_plan_ready ? 'full_plan_ready' : signal.signal_actionable ? 'actionable_without_full_stock_plan' : 'not_actionable';
  const lines = [
    `## ${signal.received_at || signal.captured_at || signal.logged_at} | ${oneLine(signal.title)} | id=${signal.message_id}`,
    '',
    '- 时间',
    `  - Discord消息时间 message_timestamp: ${numberText(signal.message_timestamp)}`,
    `  - 监听收到时间 received_at: ${numberText(signal.received_at || signal.captured_at)}`,
    `  - 落库/写入时间 logged_at: ${numberText(signal.logged_at)}`,
    `  - 消息到收到延迟 message_to_received_lag_ms: ${msText(signal.message_to_received_lag_ms)}`,
    `  - 收到到落库延迟 received_to_logged_lag_ms: ${msText(signal.received_to_logged_lag_ms)}`,
    '',
    '- 来源',
    `  - observed_via: ${numberText(signal.observed_via)}`,
    `  - source: ${numberText(signal.source)}`,
    `  - event_type: ${numberText(signal.event_type)}`,
    `  - sequence: ${numberText(record && record.sequence)}`,
    `  - channel_id: ${numberText(signal.channel_id)}`,
    `  - guild_id: ${numberText(signal.guild_id)}`,
    `  - author: ${oneLine(signal.author_username || signal.author_id || 'unknown')}`,
    `  - log_mode: ${numberText(signal.log_mode)}`,
    '',
    '- 合约与判断',
    `  - title: ${oneLine(signal.title)}`,
    `  - contract_key: ${numberText(signal.contract_key)}`,
    `  - polygon_option_ticker: ${numberText(signal.polygon_option_ticker)}`,
    `  - occ_symbol: ${numberText(signal.occ_symbol)}`,
    `  - action: ${numberText(signal.action)}`,
    `  - direction: ${numberText(signal.direction)}`,
    `  - ready: ${readyText}`,
    `  - win_rate_pct: ${numberText(signal.win_rate_pct)}`,
    `  - confidence: ${numberText(signal.confidence)}`,
    `  - risk_score: ${numberText(signal.risk_score)}`,
    `  - premium_usd: ${numberText(signal.premium_usd)}`,
    '',
    '- 股票价位计划',
    `  - entry_stock_price: ${numberText(signal.entry_stock_price)}`,
    `  - target_stock_price: ${numberText(signal.target_stock_price)}`,
    `  - stop_stock_price: ${numberText(signal.stop_stock_price)}`,
  ];

  if (intent) {
    lines.push(
      '',
      '- 下单意图',
      `  - status: ${numberText(intent.status)}`,
      `  - action: ${numberText(intent.action)}`,
      `  - option_stop_loss_pct: ${numberText(intent.option_stop_loss_pct)}`,
      `  - option_take_profit_pct: ${numberText(intent.option_take_profit_pct)}`,
      `  - requires_user_enabled_broker_execution: ${numberText(intent.requires_user_enabled_broker_execution)}`
    );
  }

  addLine(lines, 'content', record && record.content);
  addBlock(lines, 'description', signal.description);
  addBlock(lines, '执行观点/decision/结论', signal.execution_view);
  addBlock(lines, '价格结构', signal.price_structure);
  addBlock(lines, '期权结构', signal.option_structure);
  addBlock(lines, '执行计划/执行要点', signal.execution_plan);
  addBlock(lines, '失效条件/confidence_score', signal.invalidation);
  addBlock(lines, '风险提示', signal.risk_note);

  lines.push('', `- signal_key: ${signal.signal_key}`, '');
  return `${lines.join('\n')}\n`;
}

function appendSignalDocument({ signal, record, intent, signalDocDir, timeZone }) {
  const receivedAt = signal.received_at || signal.captured_at || signal.logged_at || new Date().toISOString();
  const dateKey = dateKeyForIso(receivedAt, timeZone);
  const file = path.join(signalDocDir, `${dateKey}.md`);
  if (!ensuredSignalDocs.has(file)) {
    ensureDailySignalDoc(file, dateKey, timeZone);
    ensuredSignalDocs.add(file);
  }
  fs.appendFileSync(file, buildSignalMarkdownBlock(signal, record, intent), 'utf8');
  return file;
}

module.exports = {
  appendSignalDocument,
  dateKeyForIso,
  diffIsoMs,
  resolveTimeZone,
  stampSignalLogTimes,
};
